import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type BatchWriteRetryResult, withBatchWriteRetry } from '../safety/index.js';
import type { Migration } from '../migrations/index.js';
import type { AnyElectroEntity } from '../migrations/types.js';

/**
 * RUN-03 batch-write adapter. Marshals each v2 record via the migration's
 * frozen v2 ElectroDB entity (which side-effect-validates the record's shape)
 * and ships via raw `BatchWriteCommand` under Phase 1's `withBatchWriteRetry`
 * so `UnprocessedItems`-silent-drop cannot occur.
 *
 * **Why not `migration.to.put([batch]).go()`?** Per RESEARCH §Pattern 2
 * Tradeoff option (B): we OWN the retry/audit loop because the count audit
 * triple {scanned, written, unprocessed} flows from
 * `BatchWriteRetryResult.written` directly into `count-audit.addMigrated`.
 * ElectroDB's batch-put masks that surface.
 *
 * **Validation tax:** `migration.to.put(record).params()` runs the
 * required-attribute + enum + type checks; a malformed v2 record throws BEFORE
 * the wire call. Per RUN-08 fail-fast: the marshal pass is performed in full
 * BEFORE any send, so the throw aborts the entire batch with no partial flush.
 *
 * **DDB limit:** BatchWriteItem accepts ≤25 items per call. We slice into
 * 25-record chunks and run a single `withBatchWriteRetry` per chunk so the
 * retry budget resets per chunk. Returns the SUMMED retry result.
 *
 * DATA-LOSS Pitfall #4 defense: `withBatchWriteRetry` retries all
 * `UnprocessedItems` with full-jitter exponential backoff; exhaustion throws
 * `EDBBatchWriteExhaustedError` rather than silently returning success.
 */
export interface BatchFlushArgs {
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  client: DynamoDBDocumentClient;
  tableName: string;
  records: ReadonlyArray<Record<string, unknown>>;
  onRetry?: (info: { attempt: number; delayMs: number; remaining: number }) => void;
}

const DDB_BATCH_LIMIT = 25;

// biome-ignore lint/suspicious/noExplicitAny: ElectroDB's put().params() returns a PutCommandInput shape; we only need the Item key.
type ElectroDbPutChain = { params: () => { Item?: Record<string, unknown> } | any };
type ElectroDbEntity = { put: (record: unknown) => ElectroDbPutChain };

export async function batchFlushV2(args: BatchFlushArgs): Promise<BatchWriteRetryResult> {
  if (args.records.length === 0) {
    return { scanned: 0, written: 0, unprocessed: 0 };
  }

  // Step 1: marshal every record via ElectroDB (schema validation side-effect).
  // The marshal pass runs in full BEFORE any send call — per RUN-08 fail-fast, a
  // validation throw here aborts the batch without shipping any records.
  const items: Record<string, unknown>[] = [];
  const entity = args.migration.to as unknown as ElectroDbEntity;
  for (const record of args.records) {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB params() return is dynamically shaped
    const paramsResult = (entity.put(record).params()) as { Item?: Record<string, unknown> } | Record<string, unknown>;
    // ElectroDB returns `{ Item, TableName, ... }`; the unit-test stub returns
    // the record verbatim (no Item wrapper). Accept either shape.
    const item = (paramsResult as { Item?: Record<string, unknown> }).Item ?? (paramsResult as Record<string, unknown>);
    items.push(item);
  }

  // Step 2: slice into ≤25-item chunks; run withBatchWriteRetry per chunk so
  // the retry budget resets per chunk.
  let totalScanned = 0;
  let totalWritten = 0;

  for (let i = 0; i < items.length; i += DDB_BATCH_LIMIT) {
    const chunk = items.slice(i, i + DDB_BATCH_LIMIT);

    const result = await withBatchWriteRetry({
      items: chunk,
      write: async (batch) => {
        const cmd = new BatchWriteCommand({
          RequestItems: {
            [args.tableName]: batch.map((Item) => ({ PutRequest: { Item } })),
          },
        });
        const res = (await args.client.send(cmd)) as {
          UnprocessedItems?: Record<string, Array<{ PutRequest?: { Item?: Record<string, unknown> } }>>;
        };
        const unprocessed =
          res.UnprocessedItems?.[args.tableName]
            ?.map((u) => u.PutRequest?.Item)
            .filter((x): x is Record<string, unknown> => x !== undefined) ?? [];
        return { unprocessed };
      },
      ...(args.onRetry !== undefined ? { onRetry: args.onRetry } : {}),
    });

    totalScanned += result.scanned;
    totalWritten += result.written;
  }

  return {
    scanned: totalScanned,
    written: totalWritten,
    unprocessed: totalScanned - totalWritten,
  };
}
