/**
 * Fake-clock wrapper that pairs `vi.useFakeTimers()` with `vi.setSystemTime()`.
 *
 * Plan 04's heartbeat-scheduler tests advance both `Date.now()` (so ISO heartbeat
 * timestamps step forward) and the `setTimeout` chain together. Plan 05's cache
 * thaw test drives `Date.now()` past `2 × cacheTtlMs` to verify the guard cache
 * invalidates after a Lambda freeze/thaw. Both tests want a single handle that
 * couples wall-clock to virtual timers.
 *
 * The `restore()` method MUST be called in an `afterEach` hook — leaving fake
 * timers installed corrupts unrelated test files via the shared vitest worker.
 */

import { vi } from 'vitest';

export interface FakeClockHandle {
  /** Advance virtual time by `ms`, run pending setTimeout callbacks, await microtasks. */
  advance: (ms: number) => Promise<void>;
  /** Set the wall-clock to an absolute epoch ms; does NOT trigger pending timers. */
  setNow: (epochMs: number) => void;
  /** Restore real timers AND real system time. */
  restore: () => void;
}

export const installFakeClock = (initialEpochMs = 1_700_000_000_000): FakeClockHandle => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(initialEpochMs));
  return {
    advance: async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    setNow: (epochMs: number): void => {
      vi.setSystemTime(new Date(epochMs));
    },
    restore: (): void => {
      vi.useRealTimers();
    },
  };
};
