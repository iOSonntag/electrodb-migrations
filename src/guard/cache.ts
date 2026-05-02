import type { MigrationGuardState } from '../types.js';

// Internal cache state. Mirrors MigrationGuardState plus the synthetic
// 'guard-check-failed' branch the wrapper surfaces when the underlying
// fetch throws under failureMode='closed'.
export type CachedGuardState =
  | (MigrationGuardState & { reason?: undefined })
  | { blocked: true; reason: 'guard-check-failed'; cause: unknown };

export type GuardCacheOptions = {
  ttlMs: number;
  failureMode: 'closed' | 'open';
};

export type GuardCache = {
  get: () => Promise<CachedGuardState>;
  invalidate: () => void;
};

// Maps a fresh MigrationGuardState (from the migration client) into our
// internal CachedGuardState. Trivially structural — no transformation today
// but kept as a seam in case CachedGuardState ever diverges from the public
// guard state shape.
const toCached = (state: MigrationGuardState): CachedGuardState => state;

// TTL cache with inflight-dedupe and failure-mode handling.
//
// Concurrent first-fetches share one in-flight promise so a thundering herd
// during a cold start hits the underlying fetcher exactly once. Errors are
// also cached for the TTL — under failureMode='closed' that means we fail
// fast for ttlMs without re-querying a degraded DDB.
export const createGuardCache = (
  fetcher: () => Promise<MigrationGuardState>,
  opts: GuardCacheOptions,
): GuardCache => {
  let cached: CachedGuardState | null = null;
  let expiresAt = 0;
  let inflight: Promise<CachedGuardState> | null = null;

  const refresh = async (): Promise<CachedGuardState> => {
    try {
      const state = await fetcher();
      cached = toCached(state);
    } catch (cause) {
      cached =
        opts.failureMode === 'closed'
          ? { blocked: true, reason: 'guard-check-failed', cause }
          : { blocked: false };
    }
    expiresAt = Date.now() + opts.ttlMs;
    inflight = null;
    return cached;
  };

  const get = async (): Promise<CachedGuardState> => {
    if (cached && Date.now() < expiresAt) return cached;
    if (inflight) return inflight;
    inflight = refresh();
    return inflight;
  };

  const invalidate = (): void => {
    cached = null;
    expiresAt = 0;
    // Note: an in-flight fetch is allowed to complete; its result will be
    // ignored by the next get() since cached/expiresAt have been cleared
    // and a new refresh will be triggered.
  };

  return { get, invalidate };
};
