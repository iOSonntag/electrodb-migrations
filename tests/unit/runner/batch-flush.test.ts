/**
 * Unit tests for `batchFlushV2` — the marshal+retry adapter (RUN-03).
 *
 * Test coverage per plan 04-05:
 * BF-1  Empty input fast path
 * BF-2  Single batch (≤25 records), all written
 * BF-3  Multi-batch (50 records → 2 calls of 25 each)
 * BF-4  UnprocessedItems on first attempt → retried successfully on second
 * BF-5  RUN-08 fail-fast: validation throw before client.send
 * BF-6  RUN-08 fail-fast: retry exhaustion surfaces EDBBatchWriteExhaustedError
 * BF-7  RequestItems shape: exact deep equality on 25-record batch
 * BF-8  Empty input returns immediately (no marshal calls, no send calls)
 *
 * All tests run without a real DynamoDB connection. The `client.send` is a
 * `vi.fn()` captured via `makeRunnerStubService().batchWriteSendSpy`.
 */
import { describe, expect, it, vi } from 'vitest';
import { batchFlushV2 } from '../../../src/runner/batch-flush.js';
import { makeRunnerStubService } from './_stub-service.js';

const tableName = 'test-table';

describe('runner.batchFlushV2 (RUN-03)', () => {
  it('BF-1: empty input returns {scanned:0, written:0, unprocessed:0} without calling send', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();

    const result = await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records: [],
    });

    expect(result).toEqual({ scanned: 0, written: 0, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  it('BF-2: single batch (5 records) — all written in one send call', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}`, name: 'x' }));

    const result = await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records,
    });

    expect(result).toEqual({ scanned: 5, written: 5, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);
    // Verify the marshalled items were captured (each record verbatim from stub)
    const input = stub.batchWriteSendSpy.mock.calls[0]?.[0]?.input as {
      RequestItems?: Record<string, Array<{ PutRequest: { Item: Record<string, unknown> } }>>;
    };
    expect(input?.RequestItems?.[tableName]).toHaveLength(5);
  });

  it('BF-3: multi-batch (50 records → 2 send calls of 25 each)', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = Array.from({ length: 50 }, (_, i) => ({ id: `r-${i}`, name: 'x' }));

    const result = await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records,
    });

    expect(result).toEqual({ scanned: 50, written: 50, unprocessed: 0 });
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);
    const call0Input = stub.batchWriteSendSpy.mock.calls[0]?.[0]?.input as {
      RequestItems?: Record<string, unknown[]>;
    };
    const call1Input = stub.batchWriteSendSpy.mock.calls[1]?.[0]?.input as {
      RequestItems?: Record<string, unknown[]>;
    };
    expect(call0Input?.RequestItems?.[tableName]).toHaveLength(25);
    expect(call1Input?.RequestItems?.[tableName]).toHaveLength(25);
  });

  it('BF-4: UnprocessedItems on first attempt → retried successfully; onRetry called once', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `r-${i}`, name: 'x' }));
    const onRetry = vi.fn();

    // First call returns one unprocessed item; second call succeeds.
    stub.batchWriteSendSpy.mockResolvedValueOnce({
      UnprocessedItems: {
        [tableName]: [{ PutRequest: { Item: { id: 'r-0', name: 'x' } } }],
      },
    });

    const result = await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records,
      onRetry,
    });

    expect(result).toEqual({ scanned: 5, written: 5, unprocessed: 0 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, remaining: 1 }),
    );
  });

  it('BF-5: validation failure throws BEFORE client.send (RUN-08 fail-fast)', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = Array.from({ length: 3 }, (_, i) => ({ id: `r-${i}`, name: 'x' }));

    // Override put for the migration entity to throw on first call
    const putSpy = vi.fn().mockReturnValueOnce({
      params: () => {
        throw new Error('schema validation');
      },
    });
    (migration as { to: { put: typeof putSpy } }).to.put = putSpy;

    await expect(
      batchFlushV2({
        migration: migration as never,
        client: stub.client as never,
        tableName,
        records,
      }),
    ).rejects.toThrow('schema validation');

    // send must NOT have been called — validation happens BEFORE wire
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  it('BF-6: retry exhaustion surfaces EDBBatchWriteExhaustedError (no wrap)', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = [{ id: 'r-0', name: 'x' }];

    // Always returns one unprocessed item — retry exhausts after maxAttempts (5)
    stub.batchWriteSendSpy.mockResolvedValue({
      UnprocessedItems: {
        [tableName]: [{ PutRequest: { Item: { id: 'r-0', name: 'x' } } }],
      },
    });

    await expect(
      batchFlushV2({
        migration: migration as never,
        client: stub.client as never,
        tableName,
        records,
      }),
    ).rejects.toThrow('EDB_BATCH_WRITE_EXHAUSTED');
  });

  it('BF-7: RequestItems shape for 25 records matches exact structure', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const records = Array.from({ length: 25 }, (_, i) => ({ id: `r-${i}`, name: `User ${i}` }));

    await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records,
    });

    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);
    const input = stub.batchWriteSendSpy.mock.calls[0]?.[0]?.input as {
      RequestItems?: Record<string, Array<{ PutRequest: { Item: Record<string, unknown> } }>>;
    };
    const items = input?.RequestItems?.[tableName];
    expect(items).toBeDefined();
    expect(items).toHaveLength(25);

    // Verify each item's PutRequest.Item matches its record
    for (let i = 0; i < 25; i++) {
      expect(items?.[i]).toEqual({
        PutRequest: { Item: records[i] },
      });
    }
  });

  it('BF-8: empty input returns immediately — no marshal calls, no send calls', async () => {
    const stub = makeRunnerStubService();
    const migration = stub.makeMigration();
    const putSpy = vi.fn();
    (migration as { to: { put: typeof putSpy } }).to.put = putSpy;

    const result = await batchFlushV2({
      migration: migration as never,
      client: stub.client as never,
      tableName,
      records: [],
    });

    expect(result).toEqual({ scanned: 0, written: 0, unprocessed: 0 });
    expect(putSpy).not.toHaveBeenCalled();
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });
});
