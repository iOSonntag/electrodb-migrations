/**
 * Unit tests for `applyFlow` and `applyFlowScanWrite` orchestrators.
 *
 * Test coverage per plan 04-08:
 * AF-1  Happy path call ORDER: acquireLock → startLockHeartbeat → sleep → scan → transitionToReleaseMode → sched.stop
 * AF-2  acquireWaitMs forwarded literally to sleep
 * AF-3  transitionToReleaseMode receives accurate count-audit snapshot
 * AF-4  RUN-08 fail-fast: up() throw → markFailed called, transitionToReleaseMode NOT called
 * AF-5  sched.stop() runs on success AND failure path (exactly once each)
 * AF-6  Count-audit invariant violation → markFailed + sched.stop called; error contains 'RUN-04'
 * AF-7  acquireLock failure: NO startLockHeartbeat, NO markFailed called; error re-thrown
 * AF-8  applyFlowScanWrite called directly: no acquireLock, no startLockHeartbeat, no sleep
 *
 * All tests are fully stub-based — no real DynamoDB connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures these variables are accessible inside
// vi.mock() factory callbacks even though vi.mock() is hoisted to the top.
// ---------------------------------------------------------------------------

const {
  mockAcquireLock,
  mockStopFn,
  mockStartLockHeartbeat,
  mockMarkFailed,
  mockTransitionToReleaseMode,
  mockSleep,
  mockBatchFlushV2,
} = vi.hoisted(() => {
  const mockAcquireLock = vi.fn();
  const mockStopFn = vi.fn(async () => {});
  const mockStartLockHeartbeat = vi.fn(() => ({ stop: mockStopFn }));
  const mockMarkFailed = vi.fn(async () => {});
  const mockTransitionToReleaseMode = vi.fn(async () => {});
  const mockSleep = vi.fn(async () => {});
  const mockBatchFlushV2 = vi.fn(async (args: { records: unknown[] }) => ({
    scanned: args.records.length,
    written: args.records.length,
    unprocessed: 0,
  }));
  return {
    mockAcquireLock,
    mockStopFn,
    mockStartLockHeartbeat,
    mockMarkFailed,
    mockTransitionToReleaseMode,
    mockSleep,
    mockBatchFlushV2,
  };
});

vi.mock('../../../src/lock/index.js', () => ({
  acquireLock: mockAcquireLock,
  startLockHeartbeat: mockStartLockHeartbeat,
}));

vi.mock('../../../src/state-mutations/index.js', () => ({
  markFailed: mockMarkFailed,
  transitionToReleaseMode: mockTransitionToReleaseMode,
}));

vi.mock('../../../src/runner/sleep.js', () => ({
  sleep: mockSleep,
}));

vi.mock('../../../src/runner/batch-flush.js', () => ({
  batchFlushV2: mockBatchFlushV2,
}));

// ---------------------------------------------------------------------------
// Actual imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { applyFlow, applyFlowScanWrite } from '../../../src/runner/apply-flow.js';
import { EDBMigrationLockHeldError } from '../../../src/errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(acquireWaitMs = 750) {
  return {
    lock: { acquireWaitMs, heartbeatMs: 5000, staleCutoffMs: 30_000 },
    guard: { cacheTtlMs: 500, blockMode: 'writes-only' },
    entities: [],
    migrations: '',
    region: undefined,
    tableName: 'test-table',
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    remote: undefined,
    migrationStartVersions: {},
    runner: { pageSize: 100 },
  } as never;
}

function makeMigration(
  pages: Array<Array<Record<string, unknown>>> = [],
  upFn?: (r: unknown) => Promise<unknown>,
) {
  let pageQueue = [...pages];
  const scanGo = vi.fn(async (_opts?: { cursor?: string | null; limit?: number }) => {
    const page = pageQueue.shift();
    if (!page) return { data: [], cursor: null };
    return { data: page, cursor: pageQueue.length > 0 ? 'next-token' : null };
  });
  return {
    id: 'test-migration-id',
    entityName: 'User',
    from: { scan: { go: scanGo } },
    to: { put: (r: unknown) => ({ params: () => r as Record<string, unknown> }) },
    up: upFn ?? (async (r: unknown) => ({ ...(r as object), __v: 2 })),
    scanGo,
  };
}

function makeArgs(
  overrides: {
    pages?: Array<Array<Record<string, unknown>>>;
    up?: (r: unknown) => Promise<unknown>;
    acquireWaitMs?: number;
  } = {},
) {
  const migration = makeMigration(overrides.pages, overrides.up);
  return {
    service: {} as never,
    config: makeConfig(overrides.acquireWaitMs),
    client: {} as never,
    tableName: 'test-table',
    migration: migration as never,
    runId: 'run-001',
    holder: 'cli-host',
    _migration: migration,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runner.applyFlow (RUN-01/02/04/08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBatchFlushV2.mockImplementation(async (args: { records: unknown[] }) => ({
      scanned: args.records.length,
      written: args.records.length,
      unprocessed: 0,
    }));
  });

  it('AF-1: happy path — acquireLock → startLockHeartbeat → sleep → scan → transitionToReleaseMode → sched.stop', async () => {
    const args = makeArgs({ pages: [[{ id: 'r1' }]] });

    await applyFlow(args as never);

    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(mockStartLockHeartbeat).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockTransitionToReleaseMode).toHaveBeenCalledTimes(1);
    expect(mockStopFn).toHaveBeenCalledTimes(1);

    // Strict ordering via invocationCallOrder
    const acquireOrder = mockAcquireLock.mock.invocationCallOrder[0]!;
    const heartbeatOrder = mockStartLockHeartbeat.mock.invocationCallOrder[0]!;
    const sleepOrder = mockSleep.mock.invocationCallOrder[0]!;
    const transitionOrder = mockTransitionToReleaseMode.mock.invocationCallOrder[0]!;
    const stopOrder = mockStopFn.mock.invocationCallOrder[0]!;

    expect(acquireOrder).toBeLessThan(heartbeatOrder);
    expect(heartbeatOrder).toBeLessThan(sleepOrder);
    expect(sleepOrder).toBeLessThan(transitionOrder);
    expect(transitionOrder).toBeLessThan(stopOrder);
  });

  it('AF-2: acquireWaitMs forwarded literally to sleep()', async () => {
    const args = makeArgs({ pages: [], acquireWaitMs: 750 });

    await applyFlow(args as never);

    expect(mockSleep).toHaveBeenCalledWith(750);
  });

  it('AF-3: transitionToReleaseMode receives accurate count-audit snapshot', async () => {
    // r1 → null (skipped); r2 → {...} (migrated via batchFlush)
    const args = makeArgs({
      pages: [[{ id: 'r1' }, { id: 'r2' }]],
      up: async (r) => {
        const record = r as Record<string, unknown>;
        if (record.id === 'r1') return null;
        return { ...record, __v: 2 };
      },
    });

    // 1 record passed to batchFlush, 1 written
    mockBatchFlushV2.mockResolvedValueOnce({ scanned: 1, written: 1, unprocessed: 0 });

    await applyFlow(args as never);

    expect(mockTransitionToReleaseMode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'run-001',
        migId: 'test-migration-id',
        outcome: 'applied',
        itemCounts: { scanned: 2, migrated: 1, skipped: 1, failed: 0 },
      }),
    );
  });

  it('AF-4: RUN-08 fail-fast — up() throw → markFailed called; transitionToReleaseMode NOT called', async () => {
    const upError = new Error('up() exploded');
    const args = makeArgs({
      pages: [[{ id: 'r1' }, { id: 'r2' }]],
      up: async (r) => {
        const record = r as Record<string, unknown>;
        if (record.id === 'r2') throw upError;
        return { ...record, __v: 2 };
      },
    });

    // First record writes OK
    mockBatchFlushV2.mockResolvedValueOnce({ scanned: 1, written: 1, unprocessed: 0 });

    await expect(applyFlow(args as never)).rejects.toThrow('up() exploded');

    expect(mockTransitionToReleaseMode).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'run-001',
        migId: 'test-migration-id',
        cause: upError,
      }),
    );
  });

  it('AF-5: sched.stop() runs exactly once on success AND exactly once on failure', async () => {
    // Success path
    const successArgs = makeArgs({ pages: [[{ id: 'r1' }]] });
    await applyFlow(successArgs as never);
    expect(mockStopFn).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBatchFlushV2.mockImplementation(async (args: { records: unknown[] }) => ({
      scanned: args.records.length,
      written: args.records.length,
      unprocessed: 0,
    }));

    // Failure path
    const failArgs = makeArgs({
      pages: [[{ id: 'r1' }]],
      up: async () => { throw new Error('fail'); },
    });
    await expect(applyFlow(failArgs as never)).rejects.toThrow('fail');
    expect(mockStopFn).toHaveBeenCalledTimes(1);
  });

  it('AF-6: count-audit invariant violation → markFailed + sched.stop; error contains RUN-04', async () => {
    const args = makeArgs({ pages: [[{ id: 'r1' }]] });

    // batchFlushV2 reports 2 written for 1 record → violates invariant
    mockBatchFlushV2.mockResolvedValueOnce({ scanned: 1, written: 2, unprocessed: 0 });

    const err = await applyFlow(args as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/RUN-04/);
    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockStopFn).toHaveBeenCalledTimes(1);
    expect(mockTransitionToReleaseMode).not.toHaveBeenCalled();
  });

  it('AF-7: acquireLock failure — no startLockHeartbeat, no markFailed; error re-thrown', async () => {
    const lockError = new EDBMigrationLockHeldError('held', {
      ourRunId: 'run-001',
      foundRunId: 'run-other',
      foundLockState: 'apply',
    });
    mockAcquireLock.mockRejectedValueOnce(lockError);

    const args = makeArgs({ pages: [[{ id: 'r1' }]] });

    await expect(applyFlow(args as never)).rejects.toThrow('held');

    expect(mockStartLockHeartbeat).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
  });

  it('AF-8: applyFlowScanWrite — no acquireLock, no startLockHeartbeat, no sleep; transitions normally', async () => {
    const args = makeArgs({ pages: [[{ id: 'r1' }]] });

    await applyFlowScanWrite(args as never);

    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockStartLockHeartbeat).not.toHaveBeenCalled();
    expect(mockSleep).not.toHaveBeenCalled();
    expect(mockTransitionToReleaseMode).toHaveBeenCalledTimes(1);
  });
});
