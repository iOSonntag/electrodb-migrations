import { describe, expect, it, vi } from 'vitest';
import {
  EDBBatchWriteExhaustedError,
  withBatchWriteRetry,
} from '../../../src/safety/batch-write-retry.js';

describe('withBatchWriteRetry', () => {
  it('returns success on first try when there are no unprocessed items', async () => {
    const write = vi.fn(async () => ({ unprocessed: [] as number[] }));
    const out = await withBatchWriteRetry({ items: [1, 2, 3], write });
    expect(out).toEqual({ scanned: 3, written: 3, unprocessed: 0 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds eventually', async () => {
    const responses = [{ unprocessed: [3] }, { unprocessed: [] }];
    const write = vi.fn(async () => responses.shift()!);
    const out = await withBatchWriteRetry({ items: [1, 2, 3], write, maxDelayMs: 1 });
    expect(out).toEqual({ scanned: 3, written: 3, unprocessed: 0 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('throws EDBBatchWriteExhaustedError after exhausting retries; details carry count-audit triple', async () => {
    const write = vi.fn(async () => ({ unprocessed: [1, 2, 3] }));
    let caught: unknown;
    try {
      await withBatchWriteRetry({ items: [1, 2, 3], write, maxAttempts: 5, maxDelayMs: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBBatchWriteExhaustedError);
    const err = caught as EDBBatchWriteExhaustedError;
    expect(err.code).toBe('EDB_BATCH_WRITE_EXHAUSTED');
    expect(err.details).toEqual({ scanned: 3, written: 0, unprocessed: 3 });
    // 1 initial + 5 retries
    expect(write).toHaveBeenCalledTimes(6);
  });

  it('passes the previous attempt unprocessed slice (not the original items) to the next write', async () => {
    const calls: number[][] = [];
    const responses = [{ unprocessed: [2, 3] }, { unprocessed: [3] }, { unprocessed: [] }];
    const write = vi.fn(async (batch: readonly number[]) => {
      calls.push([...batch]);
      return responses.shift()!;
    });
    await withBatchWriteRetry({ items: [1, 2, 3], write, maxDelayMs: 1 });
    expect(calls).toEqual([[1, 2, 3], [2, 3], [3]]);
  });

  it('onRetry is invoked between attempts only (not before attempt 1, not after final success)', async () => {
    const onRetry = vi.fn();
    const responses = [{ unprocessed: [3] }, { unprocessed: [3] }, { unprocessed: [] }];
    const write = async () => responses.shift()!;
    await withBatchWriteRetry({ items: [1, 2, 3], write, maxDelayMs: 1, onRetry });
    // onRetry fires before attempt 2 and before attempt 3 → 2 invocations
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('jitter delays stay within [0, cap] bound', async () => {
    const seen: number[] = [];
    const onRetry = (info: { attempt: number; delayMs: number; remaining: number }) => {
      seen.push(info.delayMs);
    };
    const write = vi.fn(async () => ({ unprocessed: [1, 2, 3] }));
    try {
      await withBatchWriteRetry({
        items: [1, 2, 3],
        write,
        maxAttempts: 5,
        maxDelayMs: 100,
        onRetry,
      });
    } catch {
      // expected exhaustion
    }
    expect(seen.length).toBe(5);
    for (const d of seen) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
  });

  it('count-audit invariant: scanned === written + unprocessed for every result', async () => {
    const write = vi.fn(async () => ({ unprocessed: [3] }));
    let caught: unknown;
    try {
      await withBatchWriteRetry({ items: [1, 2, 3], write, maxAttempts: 5, maxDelayMs: 1 });
    } catch (e) {
      caught = e;
    }
    const details = (caught as EDBBatchWriteExhaustedError).details as {
      scanned: number;
      written: number;
      unprocessed: number;
    };
    expect(details.scanned).toBe(details.written + details.unprocessed);
  });

  it('synchronous throw from write propagates without entering the retry loop', async () => {
    const write = vi.fn(() => {
      throw new Error('SDK exploded');
    });
    await expect(withBatchWriteRetry({ items: [1, 2, 3], write })).rejects.toThrow('SDK exploded');
    expect(write).toHaveBeenCalledTimes(1);
  });
});
