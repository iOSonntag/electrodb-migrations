import { EDBMigrationInProgressError } from '../errors/index.js';

/**
 * The opaque value the cache stores. Includes `value` (the lockState literal)
 * and the optional `runId` of the holding runner so the middleware can include
 * it in the thrown `EDBMigrationInProgressError.details.runId` (README §9.3).
 */
export interface LockStateValue {
  value: 'free' | 'apply' | 'rollback' | 'finalize' | 'release' | 'failed' | 'dying';
  runId?: string;
}

export interface CreateLockStateCacheArgs {
  /** TTL for the cached value, in ms. From `config.guard.cacheTtlMs`. */
  cacheTtlMs: number;
  /**
   * Caller-supplied fetch — typically wraps `readLockRow(service)` and maps
   * the row to `LockStateValue`. The cache invokes it on TTL expiry, on the
   * Pitfall #2 thaw guard trip, and after a `reset()`.
   */
  fetchLockState: () => Promise<LockStateValue>;
}

export interface LockStateCache {
  /**
   * Returns the cached value within TTL; otherwise re-reads via
   * `fetchLockState`. Concurrent callers within a fetch window share ONE
   * `fetchLockState` invocation (in-flight read deduplication, GRD-03).
   *
   * On any rejection from `fetchLockState`, throws
   * `EDBMigrationInProgressError` with `details.cause` set to the original
   * message (FAIL CLOSED — GRD-06).
   */
  get: () => Promise<LockStateValue>;
  /** Clears both the cached value and any in-flight pending Promise. */
  reset: () => void;
}

/**
 * Per-process TTL'd cache for the lock-row read with in-flight read
 * deduplication.
 *
 * **GRD-03** (per-process cache + in-flight dedup):
 * - Fresh-cached calls return the cached value without re-reading.
 * - When the cache is stale, the FIRST caller starts a fetch; CONCURRENT
 *   callers await the same in-flight Promise — N callers, ONE DDB read.
 *
 * **GRD-06 / Pitfall #1** (fail closed):
 * - Any rejection from `fetchLockState` is rethrown as
 *   `EDBMigrationInProgressError` with `details.cause` set to the original
 *   message. The cache does NOT serve a stale value on read failure; the
 *   next caller's `get()` retries the fetch (the `pending` Promise is
 *   cleared in `finally` so retries are not poisoned).
 *
 * **GRD-07 / Pitfall #2** (Lambda thaw guard):
 * - Uses `Date.now()` (wall clock — survives Lambda freeze/thaw).
 * - When `(now - cachedAt) > cacheTtlMs * 2`, forces a re-read. Handles the
 *   case where a frozen process resumes after the cache TTL has wall-clock
 *   elapsed but a timer-based TTL would NOT have fired.
 *
 * The factory returns a closure-encapsulated state machine — same pattern as
 * `src/safety/heartbeat-scheduler.ts` (lines 32–74).
 */
export function createLockStateCache(opts: CreateLockStateCacheArgs): LockStateCache {
  let cached: { value: LockStateValue; cachedAt: number } | null = null;
  let pending: Promise<LockStateValue> | null = null;

  return {
    get: async () => {
      const now = Date.now();
      // Pitfall #2 defense: fresh-cached AND age <= 2× TTL (Lambda thaw guard).
      // The `<= cacheTtlMs * 2` upper bound is redundant given `< cacheTtlMs`
      // already enforces the same property — but documents intent for review.
      if (cached && now - cached.cachedAt < opts.cacheTtlMs && now - cached.cachedAt <= opts.cacheTtlMs * 2) {
        return cached.value;
      }
      if (pending) return pending; // in-flight dedup

      pending = (async () => {
        try {
          const value = await opts.fetchLockState();
          cached = { value, cachedAt: Date.now() };
          return value;
        } catch (err) {
          // GRD-06 / Pitfall #1: fail closed.
          throw new EDBMigrationInProgressError('Failed to read lock row; failing closed for safety.', { cause: err instanceof Error ? err.message : String(err) });
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    reset: () => {
      cached = null;
      pending = null;
    },
  };
}
