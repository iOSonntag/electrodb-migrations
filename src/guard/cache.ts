import { EDBMigrationInProgressError } from '../errors/index.js';

/**
 * A frozen snapshot of the per-process lock-state cache for operator inspection.
 *
 * Exposed via {@link getGuardCacheState} so callers (e.g., `client.getGuardState()`
 * in Plan 05-10) can surface the guard's last-read result without re-reading DDB.
 *
 * **v0.1 contract** (API-05 + BLOCKER 2 / WARNING 3 design):
 * - `cacheSize`: always 0 or 1 — the cache holds at most one lock-state value at a time.
 * - `lastReadAt`: ISO timestamp of the most recent `fetchLockState` completion (resolved).
 * - `lastReadResult`: `'allow'` if the cached value was `'free'`; `'block'` otherwise.
 *
 * The shape is intentionally minimal. It may evolve in future minor versions.
 *
 * @see {@link getGuardCacheState}
 */
export interface GuardStateSnapshot {
  /** Number of cached entries currently held (always 0 or 1 for the lock-state cache). */
  readonly cacheSize: number;
  /** ISO timestamp of the most recent `fetchLockState` completion (resolved or rejected). */
  readonly lastReadAt?: string;
  /**
   * Result of the most recent `fetchLockState` — `'allow'` if `value.value === 'free'`,
   * else `'block'`.
   */
  readonly lastReadResult?: 'allow' | 'block';
}

// Module-scope snapshot mirror; updated by createLockStateCache on every successful fetch.
// Per-process global design (matches existing module-scope cache pattern).
let globalSnapshot: GuardStateSnapshot = { cacheSize: 0 };

/**
 * Return a frozen snapshot of the per-process lock-state cache.
 *
 * Reflects the most recent `createLockStateCache` instance's last `fetchLockState`
 * resolution. Returns `{ cacheSize: 0 }` before any fetch has completed.
 *
 * **Per-process global:** in a typical usage pattern, `createMigrationsClient`
 * creates exactly one `LockStateCache` per process. If multiple caches are created
 * (e.g., in tests), the snapshot reflects the LAST cache that completed a fetch.
 *
 * Used by Plan 05-10's `client.getGuardState()` surface (API-05).
 *
 * @returns A frozen copy of the current {@link GuardStateSnapshot}.
 */
export function getGuardCacheState(): GuardStateSnapshot {
  // Return a frozen copy so callers cannot mutate the module-scope state.
  return Object.freeze({ ...globalSnapshot });
}

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
          // Update the module-scope snapshot so getGuardCacheState() reflects
          // the most recent fetch result for operator inspection (WARNING 3 / API-05).
          globalSnapshot = {
            cacheSize: 1,
            lastReadAt: new Date().toISOString(),
            lastReadResult: value.value === 'free' ? 'allow' : 'block',
          };
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
      // Preserve lastReadAt and lastReadResult for diagnostic history — reset() is
      // rarely called and clearing the timestamps would discard useful operator info.
      // Update cacheSize to 0 to reflect the cleared cache.
      globalSnapshot = { ...globalSnapshot, cacheSize: 0 };
    },
  };
}
