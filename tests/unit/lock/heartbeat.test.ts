import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import * as safety from '../../../src/safety/index.js';
import * as stateMutations from '../../../src/state-mutations/index.js';

// Build a fully-defaulted ResolvedConfig the test can pass through; only the
// `lock.heartbeatMs` field matters for the wrapper.
const baseConfig: ResolvedConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: undefined,
  tableName: 'test-table',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 1_000, staleThresholdMs: 14_400_000, acquireWaitMs: 15_000 },
  guard: { cacheTtlMs: 100, blockMode: 'all' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

interface CapturedSchedulerOpts {
  intervalMs: number;
  work: () => Promise<void>;
  onAbort?: (err: unknown) => void;
  maxConsecutiveFailures?: number;
}

let capturedOpts: CapturedSchedulerOpts | null;
let stopSpy: ReturnType<typeof vi.fn>;
let startHeartbeatSchedulerSpy: ReturnType<typeof vi.fn>;
let heartbeatSpy: ReturnType<typeof vi.fn>;
let markFailedSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedOpts = null;
  stopSpy = vi.fn(async () => {});
  // Reassign the module exports' bindings directly. ESM live bindings make
  // this work for re-exports (the consuming `src/lock/heartbeat.ts` imports
  // through the same module identity).
  startHeartbeatSchedulerSpy = vi.fn((opts: CapturedSchedulerOpts) => {
    capturedOpts = opts;
    return { stop: stopSpy };
  });
  heartbeatSpy = vi.fn(async () => {});
  markFailedSpy = vi.fn(async () => {});
  vi.spyOn(safety, 'startHeartbeatScheduler').mockImplementation(startHeartbeatSchedulerSpy as never);
  vi.spyOn(stateMutations, 'heartbeat').mockImplementation(heartbeatSpy as never);
  vi.spyOn(stateMutations, 'markFailed').mockImplementation(markFailedSpy as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startLockHeartbeat (LCK-02 / LCK-10 — wrapper over startHeartbeatScheduler)', () => {
  it('forwards config.lock.heartbeatMs as intervalMs to the scheduler', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    startLockHeartbeat({ service: {} as never, config: baseConfig, runId: 'r-1' });

    expect(startHeartbeatSchedulerSpy).toHaveBeenCalledTimes(1);
    expect(capturedOpts?.intervalMs).toBe(1_000);
  });

  it('does NOT pass maxConsecutiveFailures (LCK-10: relies on Phase 1 default of 2)', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    startLockHeartbeat({ service: {} as never, config: baseConfig, runId: 'r-1' });

    expect(capturedOpts?.maxConsecutiveFailures).toBeUndefined();
  });

  it('returns the HeartbeatScheduler verbatim from Phase 1 (no field renaming)', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    const sched = startLockHeartbeat({ service: {} as never, config: baseConfig, runId: 'r-1' });

    expect(sched.stop).toBe(stopSpy);
    await sched.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('the work callback invokes state-mutations.heartbeat with {runId} on each tick', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    startLockHeartbeat({ service: { sentinel: 'svc' } as never, config: baseConfig, runId: 'r-XYZ' });

    // Drive the scheduler manually via the captured `work` callback.
    expect(capturedOpts).not.toBeNull();
    await capturedOpts?.work();
    expect(heartbeatSpy).toHaveBeenCalledTimes(1);
    expect(heartbeatSpy).toHaveBeenCalledWith({ sentinel: 'svc' }, { runId: 'r-XYZ' });

    await capturedOpts?.work();
    expect(heartbeatSpy).toHaveBeenCalledTimes(2);
  });

  it('the onAbort callback invokes state-mutations.markFailed with {runId, migId, cause} (LCK-10 watchdog)', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    startLockHeartbeat({ service: { sentinel: 'svc' } as never, config: baseConfig, runId: 'r-1', migId: 'mig-7' });

    const cause = new Error('cond fail');
    expect(capturedOpts?.onAbort).toBeDefined();
    capturedOpts?.onAbort?.(cause);
    // Allow any internal microtasks (markFailed is invoked via `void`).
    await Promise.resolve();
    await Promise.resolve();
    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    expect(markFailedSpy).toHaveBeenCalledWith({ sentinel: 'svc' }, expect.objectContaining({ runId: 'r-1', migId: 'mig-7', cause }));
  });

  it('the onAbort callback omits migId when not supplied (state-mutations.markFailed migId is optional)', async () => {
    const { startLockHeartbeat } = await import('../../../src/lock/heartbeat.js');
    startLockHeartbeat({ service: { sentinel: 'svc' } as never, config: baseConfig, runId: 'r-1' });

    const cause = new Error('boom');
    capturedOpts?.onAbort?.(cause);
    await Promise.resolve();
    await Promise.resolve();
    expect(markFailedSpy).toHaveBeenCalledTimes(1);
    const args = markFailedSpy.mock.calls[0]?.[1] as { runId: string; migId?: string; cause: unknown };
    expect(args.runId).toBe('r-1');
    expect(args.cause).toBe(cause);
    // migId omitted when not provided — duck-type for the absence.
    expect(args.migId).toBeUndefined();
  });
});
