/**
 * `createLockStateCache` — TTL'd, in-flight-deduped, fail-closed cache (GRD-03,
 * GRD-06, GRD-07).
 *
 * The cache is the choke point that lets the guard middleware satisfy GRD-06
 * (FAIL CLOSED on any error reading the lock row). It also implements the
 * Pitfall #2 thaw guard: after a Lambda freeze/thaw, wall-clock TTL math via
 * `Date.now()` correctly invalidates cache entries that age past the TTL while
 * the process was suspended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLockStateCache } from '../../../src/guard/cache.js';
import { installFakeClock } from '../../_helpers/clock.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createLockStateCache (GRD-03, GRD-06, GRD-07)', () => {
  it('returns cached value on subsequent get() within TTL', async () => {
    const fetch = vi.fn(async () => ({ value: 'free' as const }));
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    expect(await cache.get()).toEqual({ value: 'free' });
    expect(await cache.get()).toEqual({ value: 'free' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL elapses (wall-clock)', async () => {
    const clock = installFakeClock(1_700_000_000_000);
    const fetch = vi.fn(async () => ({ value: 'free' as const }));
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await cache.get();
    clock.setNow(1_700_000_006_000); // 6s later (>5s TTL)
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.restore();
  });

  it('shares ONE fetchLockState invocation across concurrent get() calls (in-flight dedup)', async () => {
    const fetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { value: 'apply' as const, runId: 'r-1' };
    });
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(a).toEqual({ value: 'apply', runId: 'r-1' });
    expect(b).toEqual({ value: 'apply', runId: 'r-1' });
    expect(c).toEqual({ value: 'apply', runId: 'r-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when fetchLockState rejects (GRD-06)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('DDB unavailable');
    });
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await expect(cache.get()).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ cause: 'DDB unavailable' }),
    });
  });

  it('fail-closed wraps non-Error rejections too (preserves stringified cause)', async () => {
    const fetch = vi.fn(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately a non-Error rejection
      throw 'literal-string-rejection' as any;
    });
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await expect(cache.get()).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ cause: 'literal-string-rejection' }),
    });
  });

  it('after a failure, retry is allowed (pending was cleared in finally)', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ value: 'free' as const });
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await expect(cache.get()).rejects.toBeInstanceOf(Error);
    expect(await cache.get()).toEqual({ value: 'free' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Lambda thaw guard: forces re-read when (now - cachedAt) > cacheTtlMs * 2 (GRD-07)', async () => {
    const clock = installFakeClock(1_700_000_000_000);
    const fetch = vi.fn(async () => ({ value: 'free' as const }));
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await cache.get();
    // Jump past 2× TTL — simulates Lambda thaw after long freeze.
    clock.setNow(1_700_000_011_000); // 11s later (>2× 5s)
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.restore();
  });

  it('reset() clears both cached and pending', async () => {
    const fetch = vi.fn(async () => ({ value: 'free' as const }));
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    await cache.get();
    cache.reset();
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT re-enter the cache when fetch returns a gating value (cache stores opaque LockStateValue)', async () => {
    // The cache is value-agnostic — it caches whatever the fetcher returns.
    // The middleware (Task 2) decides whether to gate; the cache only stores.
    const fetch = vi.fn(async () => ({ value: 'apply' as const, runId: 'r-7' }));
    const cache = createLockStateCache({ cacheTtlMs: 5_000, fetchLockState: fetch });
    expect(await cache.get()).toEqual({ value: 'apply', runId: 'r-7' });
    expect(await cache.get()).toEqual({ value: 'apply', runId: 'r-7' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
