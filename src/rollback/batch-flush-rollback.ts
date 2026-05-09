import { BatchWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type BatchWriteRetryResult, withBatchWriteRetry } from '../safety/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';

/**
 * RBK-12 heterogeneous Put+Delete batch flush composed over Phase 1's
 * `withBatchWriteRetry`.
 *
 * Handles three request types for rollback batches:
 *   - `puts` — v1 records to PUT back (projected/fill-only/custom paths).
 *     Marshalled via `migration.from.put(record).params()` (v1 entity schema
 *     validation as side-effect; fail-fast abort if schema mismatch).
 *   - `v1Deletes` — v1 mirror records to DELETE (projected type-C path; custom path).
 *     Marshalled via `migration.from.delete(record).params()`.
 *   - `v2Deletes` — v2 records to DELETE (case-1/snapshot type-B/custom).
 *     Marshalled via `migration.to.delete(record).params()`.
 *
 * **RUN-08 fail-fast:** All marshalling runs BEFORE any DDB send. A
 * `params()` throw (schema mismatch) aborts the batch without any wire traffic.
 *
 * **UnprocessedItems heterogeneous extraction:** Extracts BOTH `PutRequest.Item`
 * AND `DeleteRequest.Key` shapes from `UnprocessedItems` responses, so
 * `withBatchWriteRetry` can re-enqueue both types correctly.
 *
 * @see withBatchWriteRetry - Phase 1 retry primitive that handles Pitfall #4.
 * @see RBK-12 - Requirement for retry+audit composition on rollback flushes.
 */
export interface RollbackBatchArgs {
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  client: DynamoDBDocumentClient;
  tableName: string;
  /** v1 records to PUT back (projected/fill-only/custom paths). */
  puts?: ReadonlyArray<Record<string, unknown>>;
  /** v1 mirror records to DELETE (projected type-C path; custom path). */
  v1Deletes?: ReadonlyArray<Record<string, unknown>>;
  /** v2 records to DELETE (case-1 / snapshot type-B / custom). */
  v2Deletes?: ReadonlyArray<Record<string, unknown>>;
  onRetry?: (info: { attempt: number; delayMs: number; remaining: number }) => void;
}

const DDB_BATCH_LIMIT = 25;

// biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity.put().params() not in d.ts
type PutEntity = { put: (r: unknown) => { params: () => any } };
// biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity.delete().params() not in d.ts
type DeleteEntity = { delete: (r: unknown) => { params: () => any } };

type BatchRequest =
  | { PutRequest: { Item: Record<string, unknown> } }
  | { DeleteRequest: { Key: Record<string, unknown> } };

/**
 * Marshal all puts, v1Deletes, and v2Deletes into a unified BatchRequest array
 * BEFORE any DDB send (RUN-08 fail-fast). Awaits params() to support both the
 * synchronous real ElectroDB path and the async stub path in unit tests.
 */
async function marshalRequests(args: {
  puts: ReadonlyArray<Record<string, unknown>>;
  v1Deletes: ReadonlyArray<Record<string, unknown>>;
  v2Deletes: ReadonlyArray<Record<string, unknown>>;
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
}): Promise<BatchRequest[]> {
  const requests: BatchRequest[] = [];

  const fromPut = args.migration.from as unknown as PutEntity;
  const fromDelete = args.migration.from as unknown as DeleteEntity;
  const toDelete = args.migration.to as unknown as DeleteEntity;

  for (const record of args.puts) {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB params() return is dynamically shaped
    const p = await (fromPut.put(record).params() as any);
    // ElectroDB returns { Item, TableName, ... }; unit-test stub returns record verbatim.
    const Item = (p as { Item?: Record<string, unknown> }).Item ?? (p as Record<string, unknown>);
    requests.push({ PutRequest: { Item } });
  }

  for (const record of args.v1Deletes) {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB params() return is dynamically shaped
    const p = await (fromDelete.delete(record).params() as any);
    const Key = (p as { Key?: Record<string, unknown> }).Key ?? (p as Record<string, unknown>);
    requests.push({ DeleteRequest: { Key } });
  }

  for (const record of args.v2Deletes) {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB params() return is dynamically shaped
    const p = await (toDelete.delete(record).params() as any);
    const Key = (p as { Key?: Record<string, unknown> }).Key ?? (p as Record<string, unknown>);
    requests.push({ DeleteRequest: { Key } });
  }

  return requests;
}

export async function batchFlushRollback(args: RollbackBatchArgs): Promise<BatchWriteRetryResult> {
  const puts = args.puts ?? [];
  const v1Deletes = args.v1Deletes ?? [];
  const v2Deletes = args.v2Deletes ?? [];

  if (puts.length === 0 && v1Deletes.length === 0 && v2Deletes.length === 0) {
    return { scanned: 0, written: 0, unprocessed: 0 };
  }

  // Marshal ALL requests BEFORE any send (RUN-08 fail-fast).
  const allRequests = await marshalRequests({
    puts,
    v1Deletes,
    v2Deletes,
    migration: args.migration,
  });

  let totalScanned = 0;
  let totalWritten = 0;

  for (let i = 0; i < allRequests.length; i += DDB_BATCH_LIMIT) {
    const chunk = allRequests.slice(i, i + DDB_BATCH_LIMIT);

    const result = await withBatchWriteRetry({
      items: chunk,
      write: async (batch) => {
        const res = (await args.client.send(
          new BatchWriteCommand({
            // biome-ignore lint/suspicious/noExplicitAny: heterogeneous Put+Delete BatchRequest array; AWS SDK types are overly strict
            RequestItems: { [args.tableName]: batch as any[] },
          }),
        )) as {
          UnprocessedItems?: Record<
            string,
            Array<{
              PutRequest?: { Item?: Record<string, unknown> };
              DeleteRequest?: { Key?: Record<string, unknown> };
            }>
          >;
        };

        // Heterogeneous UnprocessedItems extraction — handle BOTH PutRequest and DeleteRequest.
        const unprocessed: BatchRequest[] =
          res.UnprocessedItems?.[args.tableName]
            ?.flatMap((u) => {
              if (u.PutRequest?.Item !== undefined) {
                return [{ PutRequest: { Item: u.PutRequest.Item } } as BatchRequest];
              }
              if (u.DeleteRequest?.Key !== undefined) {
                return [{ DeleteRequest: { Key: u.DeleteRequest.Key } } as BatchRequest];
              }
              return [];
            }) ?? [];

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
