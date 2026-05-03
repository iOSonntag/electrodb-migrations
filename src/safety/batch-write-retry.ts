import { EDBMigrationError } from '../errors/base.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Thrown by
 * `withBatchWriteRetry` when the bounded retry loop exhausts all attempts and
 * `unprocessed` items remain. The error's `details` carries the count-audit
 * triple `{scanned, written, unprocessed}` so the caller (Phase 4 runner) can
 * persist the audit on `_migrations.itemCounts` and surface it to the
 * operator. RUN-04.
 */
export class EDBBatchWriteExhaustedError extends EDBMigrationError {
  readonly code = 'EDB_BATCH_WRITE_EXHAUSTED' as const;
}

export interface BatchWriteRetryOptions<T> {
  items: readonly T[];
  /**
   * Caller does the actual SDK send; receives a slice ≤ 25 items, returns the
   * SDK response shape `{unprocessed}`. Phase 4 wires this to a real
   * `BatchWriteCommand`.
   */
  write: (batch: readonly T[]) => Promise<{ unprocessed: readonly T[] }>;
  /** Default 5 (so 6 total tries: initial + 5 retries). RUN-03. */
  maxAttempts?: number;
  /** Default 30_000ms cap on the jitter window. */
  maxDelayMs?: number;
  /** Optional sink for retry observability. */
  onRetry?: (info: { attempt: number; delayMs: number; remaining: number }) => void;
}

export interface BatchWriteRetryResult {
  /** Initial item count. Always equals `options.items.length`. */
  scanned: number;
  /** Successfully written: `scanned - unprocessed` at exit. */
  written: number;
  /** Remaining unprocessed items at exit. Zero on success; non-zero on throw. */
  unprocessed: number;
}

/**
 * Pitfall #4 — DDB's `BatchWriteItem` returns `success` even when the
 * `UnprocessedItems` set is non-empty. Without the retry loop, "no error →
 * done" silently drops records and corrupts post-finalize state.
 *
 * Implementation:
 * - Up to `maxAttempts` retries (default 5) using full-jitter exponential
 *   backoff: `delay = floor(random() * min(maxDelayMs, 100 * 2^attempt))`.
 * - On exhaustion, throws `EDBBatchWriteExhaustedError` with the count-audit
 *   triple in `details`. Reference: AWS Architecture Blog "Exponential
 *   Backoff and Jitter" (2015).
 */
export async function withBatchWriteRetry<T>(opts: BatchWriteRetryOptions<T>): Promise<BatchWriteRetryResult> {
  const items = [...opts.items];
  const maxAttempts = opts.maxAttempts ?? 5;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const scanned = items.length;

  let pending: readonly T[] = items;
  let attempt = 0;

  while (pending.length > 0 && attempt <= maxAttempts) {
    if (attempt > 0) {
      const cap = Math.min(maxDelayMs, 100 * 2 ** attempt);
      const delayMs = Math.floor(Math.random() * cap);
      opts.onRetry?.({ attempt, delayMs, remaining: pending.length });
      await new Promise((r) => setTimeout(r, delayMs));
    }
    const { unprocessed } = await opts.write(pending);
    pending = unprocessed;
    attempt += 1;
  }

  const result: BatchWriteRetryResult = {
    scanned,
    written: scanned - pending.length,
    unprocessed: pending.length,
  };

  if (pending.length > 0) {
    throw new EDBBatchWriteExhaustedError(`BatchWriteItem retry exhausted after ${maxAttempts} attempts: ` + `${pending.length}/${scanned} items unprocessed`, { ...result });
  }

  return result;
}
