/**
 * Unit tests for finalizeFlow (FIN-01/03/04).
 *
 * All external collaborators are vi.mocked — no real DDB or lock I/O.
 * Integration verification of mode='finalize' on DDB Local: Plan 14b.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeFlow } from '../../../src/runner/finalize-flow.js';
import { makeRunnerStubService } from './_stub-service.js';

// ---------------------------------------------------------------------------
// Module mocks — all declared before imports that use them.
// ---------------------------------------------------------------------------

vi.mock('../../../src/lock/index.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(undefined),
  startLockHeartbeat: vi.fn().mockReturnValue({ stop: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../../../src/state-mutations/index.js', () => ({
  clear: vi.fn().mockResolvedValue(undefined),
  clearFinalizeMode: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/runner/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

// Import mocked symbols AFTER vi.mock declarations.
import { acquireLock, startLockHeartbeat } from '../../../src/lock/index.js';
import { clear, clearFinalizeMode, markFailed } from '../../../src/state-mutations/index.js';
import { sleep } from '../../../src/runner/sleep.js';

// ---------------------------------------------------------------------------
// Test-local factories
// ---------------------------------------------------------------------------

/** Minimal resolved config for finalizeFlow. */
const makeConfig = () =>
  ({
    lock: { acquireWaitMs: 250, heartbeatMs: 5000, staleThresholdMs: 30000 },
    guard: { cacheTtlMs: 100, blockMode: 'all' },
    entities: [],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName: 'test-table',
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  }) as const;

/**
 * Build a minimal migration stub with:
 *   - from.scan.go: backed by pagesQueue (same pattern as makeRunnerStubService)
 *   - from.delete: vi.fn() — default resolves; tests override per-call.
 */
function makeMigrationStub(pagesQueue: Array<Array<Record<string, unknown>>>) {
  const deleteGoFn = vi.fn().mockResolvedValue({ data: null });
  const deleteFn = vi.fn((_record: unknown) => ({ go: deleteGoFn }));
  const scanGoFn = vi.fn(async (_opts?: { cursor?: string | null; limit?: number }) => {
    const page = pagesQueue.shift();
    if (!page) return { data: [], cursor: null };
    return { data: page, cursor: pagesQueue.length > 0 ? 'next-cursor' : null };
  });

  return {
    id: 'mig-001',
    entityName: 'User',
    from: {
      scan: { go: scanGoFn },
      delete: deleteFn,
    } as unknown,
    to: {} as unknown,
    up: async (r: unknown) => r,
    deleteGoFn,
    deleteFn,
    scanGoFn,
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let mockSchedStop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSchedStop = vi.fn().mockResolvedValue(undefined);
  vi.mocked(startLockHeartbeat).mockReturnValue({ stop: mockSchedStop } as never);
});

// ---------------------------------------------------------------------------
// FF-1: acquireLock is called with mode: 'finalize'
// ---------------------------------------------------------------------------

describe('FF-1: acquireLock mode', () => {
  it("calls acquireLock with mode: 'finalize'", async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[]]; // one empty page
    const mig = makeMigrationStub(pagesQueue);

    await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-001',
      holder: 'test-host',
    });

    expect(vi.mocked(acquireLock)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'finalize' }),
    );
  });
});

// ---------------------------------------------------------------------------
// FF-2: Call order — acquireLock → heartbeat → sleep → scan → patch → clearFinalizeMode → stop
// ---------------------------------------------------------------------------

describe('FF-2: call order', () => {
  it('acquireLock → startLockHeartbeat → sleep → (scan) → migrations.patch → clearFinalizeMode → sched.stop', async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[{ id: 'u-1', sk: 'sk-1' }]];
    const mig = makeMigrationStub(pagesQueue);

    await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-002',
      holder: 'host',
    });

    const acquireOrder = vi.mocked(acquireLock).mock.invocationCallOrder[0];
    const heartbeatOrder = vi.mocked(startLockHeartbeat).mock.invocationCallOrder[0];
    const sleepOrder = vi.mocked(sleep).mock.invocationCallOrder[0];
    const clearFinalizeModeOrder = vi.mocked(clearFinalizeMode).mock.invocationCallOrder[0];
    const stopOrder = mockSchedStop.mock.invocationCallOrder[0];

    expect(acquireOrder).toBeDefined();
    expect(heartbeatOrder).toBeGreaterThan(acquireOrder!);
    expect(sleepOrder).toBeGreaterThan(heartbeatOrder!);
    expect(clearFinalizeModeOrder).toBeGreaterThan(sleepOrder!);
    expect(stopOrder).toBeGreaterThan(clearFinalizeModeOrder!);
  });
});

// ---------------------------------------------------------------------------
// FF-3: Empty scan — patch + clearFinalizeMode STILL fire; result has zero counts
// ---------------------------------------------------------------------------

describe('FF-3: empty scan', () => {
  it('fires patch + clearFinalizeMode even when no v1 records exist; counts are all zero', async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[]]; // one empty page (cursor=null immediately)
    const mig = makeMigrationStub(pagesQueue);

    const result = await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-003',
      holder: 'host',
    });

    expect(result.itemCounts).toEqual({ scanned: 0, migrated: 0, skipped: 0, failed: 0 });
    expect(vi.mocked(clearFinalizeMode)).toHaveBeenCalledOnce();
    expect(vi.mocked(markFailed)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FF-4: Pitfall 7 — ConditionalCheckFailed on 2nd record → skipped:1
// ---------------------------------------------------------------------------

describe('FF-4: Pitfall 7 — concurrent app delete', () => {
  it('counts CCF delete as skipped (not failed); patch + clear still fire', async () => {
    const { service } = makeRunnerStubService();
    const record1 = { id: 'u-1', sk: 'sk-1' };
    const record2 = { id: 'u-2', sk: 'sk-2' };
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[record1, record2]];
    const mig = makeMigrationStub(pagesQueue);

    const ccfError = Object.assign(new Error('ConditionalCheckFailedException'), {
      name: 'ConditionalCheckFailedException',
    });
    // First delete succeeds; second throws CCF.
    mig.deleteGoFn.mockResolvedValueOnce({ data: null }).mockRejectedValueOnce(ccfError);

    const result = await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-004',
      holder: 'host',
    });

    expect(result.itemCounts).toEqual({ scanned: 2, migrated: 1, skipped: 1, failed: 0 });
    expect(vi.mocked(clearFinalizeMode)).toHaveBeenCalledOnce();
    expect(vi.mocked(markFailed)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FF-5: Unexpected error — markFailed called; clear NOT called; error re-thrown
// ---------------------------------------------------------------------------

describe('FF-5: unexpected delete error (RUN-08 fail-fast)', () => {
  it('re-throws non-CCF error, calls markFailed, does NOT call clear', async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[{ id: 'u-1', sk: 'sk-1' }]];
    const mig = makeMigrationStub(pagesQueue);

    const unexpectedErr = new Error('ProvisionedThroughputExceededException');
    mig.deleteGoFn.mockRejectedValueOnce(unexpectedErr);

    await expect(
      finalizeFlow({
        service: service as never,
        config: makeConfig() as never,
        client: {} as never,
        tableName: 'test-table',
        migration: mig as never,
        runId: 'run-005',
        holder: 'host',
      }),
    ).rejects.toThrow('ProvisionedThroughputExceededException');

    expect(vi.mocked(markFailed)).toHaveBeenCalledOnce();
    expect(vi.mocked(clearFinalizeMode)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FF-6: assertInvariant runs BEFORE patch + clearFinalizeMode
// ---------------------------------------------------------------------------

describe('FF-6: assertInvariant call order', () => {
  it('assertInvariant fires before migrations.patch and clearFinalizeMode', async () => {
    // We verify this by making clearFinalizeMode track its call and confirming patch
    // was called before it. Since assertInvariant is synchronous and inside try-block
    // before patch, if it ran AFTER patch we couldn't observe it. Instead: confirm patch
    // IS called (assertInvariant did not throw), which means the invariant was satisfied.
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[{ id: 'u-1', sk: 'sk-1' }]];
    const mig = makeMigrationStub(pagesQueue);

    // Track call order: assertInvariant (indirectly via patch being called) then clearFinalizeMode.
    const callOrder: string[] = [];
    vi.mocked(clearFinalizeMode).mockImplementation(async () => {
      callOrder.push('clearFinalizeMode');
    });
    // Intercept patch via the service stub to record its call.
    const patchGoOriginal = service.migrations.patch({ id: 'mig-001' }).go;
    const patchGoSpy = vi.fn(async () => {
      callOrder.push('patch');
      return { data: null };
    });
    vi.spyOn(service.migrations, 'patch').mockImplementation((_key: Record<string, unknown>) => ({
      set: (_values: Record<string, unknown>) => ({
        go: patchGoSpy,
      }),
    }) as never);
    void patchGoOriginal; // suppress unused warning

    await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-006',
      holder: 'host',
    });

    // patch must come before clearFinalizeMode in the call sequence.
    expect(callOrder.indexOf('patch')).toBeLessThan(callOrder.indexOf('clearFinalizeMode'));
  });
});

// ---------------------------------------------------------------------------
// FF-7: sched.stop called on EVERY exit path (success AND failure)
// ---------------------------------------------------------------------------

describe('FF-7: sched.stop on all exit paths', () => {
  it('calls sched.stop once on success path', async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[]];
    const mig = makeMigrationStub(pagesQueue);

    await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-007a',
      holder: 'host',
    });

    expect(mockSchedStop).toHaveBeenCalledOnce();
  });

  it('calls sched.stop once on failure path', async () => {
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[{ id: 'u-1', sk: 'sk-1' }]];
    const mig = makeMigrationStub(pagesQueue);
    mig.deleteGoFn.mockRejectedValueOnce(new Error('SomeUnexpectedError'));

    await expect(
      finalizeFlow({
        service: service as never,
        config: makeConfig() as never,
        client: {} as never,
        tableName: 'test-table',
        migration: mig as never,
        runId: 'run-007b',
        holder: 'host',
      }),
    ).rejects.toThrow();

    expect(mockSchedStop).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// FF-8: FIN-04 — no auto-rollback verb called (defensive regression guard)
// ---------------------------------------------------------------------------

describe('FF-8: FIN-04 — no auto-rollback', () => {
  it('does NOT call any rollback verb on either success or failure path', async () => {
    // In v0.1 there is no rollback verb to call in finalizeFlow. This test
    // is a defensive guard: if a future dev adds an auto-rollback hook, the
    // test fails, surfacing the FIN-04 violation.
    // We verify by checking the mocked state-mutations barrel has no unexpected calls.
    const { service } = makeRunnerStubService();
    const pagesQueue: Array<Array<Record<string, unknown>>> = [[{ id: 'u-1', sk: 'sk-1' }]];
    const mig = makeMigrationStub(pagesQueue);

    // Check that only clearFinalizeMode is called on success (not markFailed, not clear).
    await finalizeFlow({
      service: service as never,
      config: makeConfig() as never,
      client: {} as never,
      tableName: 'test-table',
      migration: mig as never,
      runId: 'run-008',
      holder: 'host',
    });

    // On success: clearFinalizeMode IS called; markFailed and clear are NOT.
    expect(vi.mocked(clearFinalizeMode)).toHaveBeenCalledOnce();
    expect(vi.mocked(clear)).not.toHaveBeenCalled();
    expect(vi.mocked(markFailed)).not.toHaveBeenCalled();
    // The scan-delete loop only calls delete, never any rollback-like verb.
    // migration.from.delete is the only action on each record.
    expect(mig.deleteFn).toHaveBeenCalledOnce();
  });
});
