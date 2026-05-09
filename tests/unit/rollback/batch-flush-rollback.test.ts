/**
 * Unit tests for batchFlushRollback — heterogeneous Put+Delete batch flush
 * composed over withBatchWriteRetry (RBK-12).
 *
 * Uses `makeRollbackStubService()` from Plan 05-01. The `batchWriteSendSpy`
 * captures all `BatchWriteCommand` sends; tests assert RequestItems shapes,
 * call counts, and retry behavior.
 *
 * Key invariants (acceptance criteria):
 * - DDB_BATCH_LIMIT = 25 items per BatchWriteItem call
 * - Puts use migration.from.put().params() (reverts to v1)
 * - v1Deletes use migration.from.delete().params()
 * - v2Deletes use migration.to.delete().params()
 * - UnprocessedItems extraction handles BOTH PutRequest.Item AND DeleteRequest.Key
 * - Marshal fail-fast: params() throw aborts BEFORE any send
 */
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { batchFlushRollback } from '../../../src/rollback/batch-flush-rollback.js';
import { makeRollbackStubService } from './_stub-service.js';

const tableName = 'test-table';

describe('batchFlushRollback (RBK-12)', () => {
  it('empty puts/deletes → {scanned:0, written:0, unprocessed:0}; spy NOT called', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
    });

    expect(result).toEqual({ scanned: 0, written: 0, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  it('5 puts only → spy called once with 5 PutRequest entries', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 5 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
    });

    expect(result).toEqual({ scanned: 5, written: 5, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    const cmd = stub.batchWriteSendSpy.mock.calls[0]?.[0] as BatchWriteCommand;
    const requests = cmd.input.RequestItems?.[tableName];
    expect(requests).toHaveLength(5);
    // All should be PutRequest entries (v1 puts)
    for (const req of requests ?? []) {
      expect(req).toHaveProperty('PutRequest');
      expect(req).not.toHaveProperty('DeleteRequest');
    }
  });

  it('5 v2Deletes only → spy called once with 5 DeleteRequest entries', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const v2Deletes = Array.from({ length: 5 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}`, status: 'active' }));

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      v2Deletes,
    });

    expect(result).toEqual({ scanned: 5, written: 5, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    const cmd = stub.batchWriteSendSpy.mock.calls[0]?.[0] as BatchWriteCommand;
    const requests = cmd.input.RequestItems?.[tableName];
    expect(requests).toHaveLength(5);
    // All should be DeleteRequest entries
    for (const req of requests ?? []) {
      expect(req).toHaveProperty('DeleteRequest');
      expect(req).not.toHaveProperty('PutRequest');
    }
  });

  it('3 puts + 2 v2Deletes (heterogeneous) → spy called once with mixed array of 5', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 3 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));
    const v2Deletes = Array.from({ length: 2 }, (_, i) => ({ id: `v2-${i}`, name: `V2 ${i}`, status: 'active' }));

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
      v2Deletes,
    });

    expect(result).toEqual({ scanned: 5, written: 5, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    const cmd = stub.batchWriteSendSpy.mock.calls[0]?.[0] as BatchWriteCommand;
    const requests = cmd.input.RequestItems?.[tableName];
    expect(requests).toHaveLength(5);

    const putRequests = (requests ?? []).filter((r) => 'PutRequest' in r);
    const deleteRequests = (requests ?? []).filter((r) => 'DeleteRequest' in r);
    expect(putRequests).toHaveLength(3);
    expect(deleteRequests).toHaveLength(2);
  });

  it('30 puts → spy called twice (25 + 5 slicing)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 30 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
    });

    expect(result).toEqual({ scanned: 30, written: 30, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);

    const call0 = stub.batchWriteSendSpy.mock.calls[0]?.[0] as BatchWriteCommand;
    const call1 = stub.batchWriteSendSpy.mock.calls[1]?.[0] as BatchWriteCommand;
    expect(call0.input.RequestItems?.[tableName]).toHaveLength(25);
    expect(call1.input.RequestItems?.[tableName]).toHaveLength(5);
  });

  it('30 mixed puts+deletes → spy called twice with correct total (25 + 5)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 15 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));
    const v2Deletes = Array.from({ length: 15 }, (_, i) => ({ id: `v2-${i}`, name: `V2 ${i}`, status: 'active' }));

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
      v2Deletes,
    });

    expect(result).toEqual({ scanned: 30, written: 30, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);

    const call0 = stub.batchWriteSendSpy.mock.calls[0]?.[0] as BatchWriteCommand;
    const call1 = stub.batchWriteSendSpy.mock.calls[1]?.[0] as BatchWriteCommand;
    expect(call0.input.RequestItems?.[tableName]).toHaveLength(25);
    expect(call1.input.RequestItems?.[tableName]).toHaveLength(5);
  });

  it('UnprocessedItems response: PutRequests are retried; final written === scanned', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 5 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));

    // First call returns 2 unprocessed PutRequests; second call succeeds.
    const unprocessedPut = { PutRequest: { Item: { id: 'u-0', name: 'User 0' } } };
    const unprocessedPut2 = { PutRequest: { Item: { id: 'u-1', name: 'User 1' } } };
    stub.batchWriteSendSpy.mockResolvedValueOnce({
      UnprocessedItems: { [tableName]: [unprocessedPut, unprocessedPut2] },
    });

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
    });

    expect(result.scanned).toBe(5);
    expect(result.written).toBe(5);
    expect(result.unprocessed).toBe(0);
    // spy called twice: initial + retry for 2 unprocessed
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);
  });

  it('UnprocessedItems with mixed PutRequest + DeleteRequest shapes — both retried (heterogeneous extraction)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();
    const puts = Array.from({ length: 2 }, (_, i) => ({ id: `u-${i}`, name: `User ${i}` }));
    const v2Deletes = Array.from({ length: 2 }, (_, i) => ({ id: `v2-${i}`, name: `V2 ${i}`, status: 'active' }));

    // Return one PutRequest + one DeleteRequest as unprocessed.
    const unprocessedPut = { PutRequest: { Item: { id: 'u-0', name: 'User 0' } } };
    const unprocessedDelete = { DeleteRequest: { Key: { pk: 'v2-0', sk: 'v2-0' } } };
    stub.batchWriteSendSpy.mockResolvedValueOnce({
      UnprocessedItems: { [tableName]: [unprocessedPut, unprocessedDelete] },
    });

    const result = await batchFlushRollback({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      puts,
      v2Deletes,
    });

    expect(result.scanned).toBe(4);
    expect(result.written).toBe(4);
    expect(result.unprocessed).toBe(0);
    // spy called twice: initial + retry for the 2 unprocessed items
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);
  });

  it('puts with record that fails put().params() → marshal throws BEFORE spy call', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration();

    // Override migration.from.put() to throw on params() for first record.
    const badRecord = { id: 'bad', name: 'Bad' };
    const origFrom = migration.from;
    // biome-ignore lint/suspicious/noExplicitAny: test override
    (migration as any).from = {
      ...origFrom,
      put: (record: Record<string, unknown>) => ({
        params: () => {
          if (record.id === 'bad') throw new Error('schema validation failure');
          return record;
        },
      }),
      delete: origFrom.delete.bind(origFrom),
    };

    await expect(
      batchFlushRollback({
        migration: migration as never,
        client: stub.client as never,
        tableName,
        puts: [badRecord],
      }),
    ).rejects.toThrow('schema validation failure');

    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });
});
