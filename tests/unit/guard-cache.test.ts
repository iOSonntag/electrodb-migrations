import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuardCache } from '../../src/guard/cache.js';
import type { MigrationGuardState } from '../../src/types.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const okState: MigrationGuardState = { blocked: false };
const lockedState: MigrationGuardState = {
  blocked: true,
  reasons: ['locked'],
  lock: {
    locked: true,
    stale: false,
    heldBy: 'host:1',
    operation: 'apply',
    migrationId: 'm1',
    acquiredAt: '2026-04-30T00:00:00.000Z',
    heartbeatAt: '2026-04-30T00:00:01.000Z',
    refId: 'r1',
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createGuardCache', () => {
  it('returns the freshly fetched state on first call', async () => {
    const fetcher = vi.fn().mockResolvedValue(okState);
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });
    const result = await cache.get();
    expect(result).toEqual({ blocked: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves a hit within TTL without re-fetching', async () => {
    const fetcher = vi.fn().mockResolvedValue(okState);
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    await cache.get();
    await vi.advanceTimersByTimeAsync(500);
    await cache.get();
    await cache.get();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(okState).mockResolvedValueOnce(lockedState);
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    const first = await cache.get();
    expect(first).toEqual({ blocked: false });

    await vi.advanceTimersByTimeAsync(1001);
    const second = await cache.get();
    expect(second.blocked).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent first-fetches into a single call', async () => {
    let resolveFetch!: (s: MigrationGuardState) => void;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<MigrationGuardState>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    const a = cache.get();
    const b = cache.get();
    const c = cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(okState);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toEqual({ blocked: false });
    expect(rb).toEqual({ blocked: false });
    expect(rc).toEqual({ blocked: false });
  });

  it('fail-closed: synthesizes a blocked state with reason=guard-check-failed when fetcher rejects', async () => {
    const cause = new Error('DDB throttled');
    const fetcher = vi.fn().mockRejectedValue(cause);
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    const result = await cache.get();
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error('unreachable');
    expect(result.reason).toBe('guard-check-failed');
    if (result.reason !== 'guard-check-failed') throw new Error('unreachable');
    expect(result.cause).toBe(cause);
  });

  it('fail-open: returns { blocked: false } when fetcher rejects', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'open' });

    const result = await cache.get();
    expect(result).toEqual({ blocked: false });
  });

  it('caches error states to avoid hammering DDB while it stays down', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('still down'));
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    await cache.get();
    await cache.get();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next get() to re-fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(okState);
    const cache = createGuardCache(fetcher, { ttlMs: 60_000, failureMode: 'closed' });

    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1);

    cache.invalidate();
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('after a failure cycle, recovers on next refresh past the TTL', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(okState);
    const cache = createGuardCache(fetcher, { ttlMs: 1000, failureMode: 'closed' });

    const first = await cache.get();
    expect(first.blocked).toBe(true);

    await vi.advanceTimersByTimeAsync(1001);
    const second = await cache.get();
    expect(second).toEqual({ blocked: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// Real-time, no fake timers, just to keep the sleep helper used.
describe('createGuardCache (no fake timers)', () => {
  it('does not freeze when used without timer mocks', async () => {
    vi.useRealTimers();
    const fetcher = vi.fn().mockResolvedValue(okState);
    const cache = createGuardCache(fetcher, { ttlMs: 50, failureMode: 'closed' });
    await cache.get();
    await sleep(60);
    await cache.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
