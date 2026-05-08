/**
 * Trivial Promise wrapper around `setTimeout`. Used by `apply-flow.ts`
 * for the LCK-04 `await sleep(config.lock.acquireWaitMs)` window between
 * `acquireLock` and the first scan call. The wait gives any guarded
 * process whose cache is mid-TTL time to refresh before the migration's
 * first transform write — defends Pitfall 1 / DATA-LOSS via stale guard
 * cache.
 *
 * Using `setTimeout` here is correct (not the same Pitfall 2 case as
 * heartbeat — heartbeat must be a self-rescheduling chain to survive
 * Lambda freeze/thaw; a one-shot sleep has no such concern).
 */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
