import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { staleCutoffIso } from '../../../src/lock/stale-cutoff.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('staleCutoffIso (pure helper, single source of truth for stale-cutoff math)', () => {
  it('returns Date.now() - staleThresholdMs as an ISO-8601 string with a 4-hour threshold', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    const config = { lock: { staleThresholdMs: 14_400_000 /* 4h */ } } as ResolvedConfig;
    expect(staleCutoffIso(config)).toBe('2026-05-08T08:00:00.000Z');
  });

  it('honors a small staleThresholdMs (60s)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.000Z'));
    expect(staleCutoffIso({ lock: { staleThresholdMs: 60_000 } } as ResolvedConfig)).toBe('2026-05-08T11:59:00.000Z');
  });

  it('returns ISO-8601 with millisecond precision (.000Z suffix)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T12:00:00.123Z'));
    const config = { lock: { staleThresholdMs: 1_000 } } as ResolvedConfig;
    expect(staleCutoffIso(config)).toBe('2026-05-08T11:59:59.123Z');
  });
});
