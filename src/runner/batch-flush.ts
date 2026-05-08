import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type BatchWriteRetryResult, withBatchWriteRetry } from '../safety/index.js';
import type { Migration } from '../migrations/index.js';
import type { AnyElectroEntity } from '../migrations/types.js';

/**
 * RUN-03 batch-write adapter.
 *
 * Marshals each v2 record via `migration.to.put(record).params()` (ElectroDB
 * schema validation as a side-effect) then ships via raw `BatchWriteCommand`
 * inside `withBatchWriteRetry` — so `UnprocessedItems` silent-drop cannot
 * occur (DATA-LOSS Pitfall #4).
 *
 * The entire marshal pass runs BEFORE any send (RUN-08 fail-fast). Slices into
 * ≤25-record chunks per DDB BatchWriteItem limit; retry budget resets per chunk.
 * Returns the SUMMED `{scanned, written, unprocessed}` audit triple.
 */
export interface BatchFlushArgs {
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  client: DynamoDBDocumentClient;
  tableName: string;
  records: ReadonlyArray<Record<string, unknown>>;
  onRetry?: (info: { attempt: number; delayMs: number; remaining: number }) => void;
}

const DDB_BATCH_LIMIT = 25;

// biome-ignore lint/suspicious/noExplicitAny: ElectroDB put().params() returns PutCommandInput; we only need the Item key.
type PutEntity = { put: (r: unknown) => { params: () => { Item?: Record<string, unknown> } | any } };

export async function batchFlushV2(args: BatchFlushArgs): Promise<BatchWriteRetryResult> {
  if (args.records.length === 0) return { scanned: 0, written: 0, unprocessed: 0 };

  // Marshal ALL records before any send (RUN-08 fail-fast: validation throw aborts batch cleanly).
  const items: Record<string, unknown>[] = [];
  const entity = args.migration.to as unknown as PutEntity;
  for (const record of args.records) {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB params() return is dynamically shaped
    const p = entity.put(record).params() as { Item?: Record<string, unknown> } | Record<string, unknown>;
    // ElectroDB returns { Item, TableName, ... }; unit-test stub returns record verbatim.
    items.push((p as { Item?: Record<string, unknown> }).Item ?? (p as Record<string, unknown>));
  }

  let totalScanned = 0;
  let totalWritten = 0;

  for (let i = 0; i < items.length; i += DDB_BATCH_LIMIT) {
    const result = await withBatchWriteRetry({
      items: items.slice(i, i + DDB_BATCH_LIMIT),
      write: async (batch) => {
        const res = (await args.client.send(
          new BatchWriteCommand({ RequestItems: { [args.tableName]: batch.map((Item) => ({ PutRequest: { Item } })) } }),
        )) as { UnprocessedItems?: Record<string, Array<{ PutRequest?: { Item?: Record<string, unknown> } }>> };
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
