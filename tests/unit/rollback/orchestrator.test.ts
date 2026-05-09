/**
 * Unit tests for `rollback` orchestrator — Phase 5 Plan 09 (TDD RED).
 *
 * Coverage map:
 *  RB-01  Refusal path — preconditions refuses; acquireLock NOT called
 *  RB-02  Order invariant — acquireLock → startLockHeartbeat → sleep → strategy → audit.assertInvariant → transitionToReleaseMode
 *  RB-03  Sleep timing — sleep called with args.config.lock.acquireWaitMs
 *  RB-04  Case 1 dispatch — rollbackCase1 called; classifyTypeTable NOT called
 *  RB-05  Case 2 + projected dispatch
 *  RB-06  Case 2 + snapshot dispatch
 *  RB-07  Case 2 + fill-only dispatch
 *  RB-08  Case 2 + custom dispatch
 *  RB-09  Case 3 + projected dispatch
 *  RB-10  Strategy throw → markFailed called; error re-thrown; sched.stop called
 *  RB-11  markFailed throws inside catch → sched.stop still called; original error re-thrown
 *  RB-12  Audit invariant break → markFailed called; transitionToReleaseMode NOT called
 *  RB-13  transitionToReleaseMode receives rollbackStrategy (Pitfall 9) — all 4 strategies
 *  RB-14  Snapshot pass-through — yes:true + io passed to executeSnapshot
 *  RB-15  WARNING 4 — io.confirm reference equality when strategy='snapshot' and yes is absent
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.hoisted ensures variables are accessible in vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockAcquireLock,
  mockStopFn,
  mockStartLockHeartbeat,
  mockMarkFailed,
  mockTransitionToReleaseMode,
  mockSleep,
  mockCheckPreconditions,
  mockClassifyTypeTable,
  mockCreateRollbackAudit,
  mockExecuteProjected,
  mockExecuteSnapshot,
  mockExecuteFillOnly,
  mockExecuteCustom,
  mockRollbackCase1,
  mockBuildCtx,
} = vi.hoisted(() => {
  const mockAcquireLock = vi.fn(async () => {});
  const mockStopFn = vi.fn(async () => {});
  const mockStartLockHeartbeat = vi.fn(() => ({ stop: mockStopFn }));
  const mockMarkFailed = vi.fn(async () => {});
  const mockTransitionToReleaseMode = vi.fn(async () => {});
  const mockSleep = vi.fn(async () => {});
  const mockCheckPreconditions = vi.fn();
  const mockClassifyTypeTable = vi.fn();
  const mockCreateRollbackAudit = vi.fn();
  const mockExecuteProjected = vi.fn(async () => {});
  const mockExecuteSnapshot = vi.fn(async () => {});
  const mockExecuteFillOnly = vi.fn(async () => {});
  const mockExecuteCustom = vi.fn(async () => {});
  const mockRollbackCase1 = vi.fn(async () => ({}));
  // Phase 6 / CTX-01 — mock buildCtx so orchestrator tests don't need snapshot files
  const mockBuildCtx = vi.fn(async () => ({ entity: vi.fn() }));
  return {
    mockAcquireLock,
    mockStopFn,
    mockStartLockHeartbeat,
    mockMarkFailed,
    mockTransitionToReleaseMode,
    mockSleep,
    mockCheckPreconditions,
    mockClassifyTypeTable,
    mockCreateRollbackAudit,
    mockExecuteProjected,
    mockExecuteSnapshot,
    mockExecuteFillOnly,
    mockExecuteCustom,
    mockRollbackCase1,
    mockBuildCtx,
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

vi.mock('../../../src/rollback/preconditions.js', () => ({
  checkPreconditions: mockCheckPreconditions,
}));

vi.mock('../../../src/rollback/type-table.js', () => ({
  classifyTypeTable: mockClassifyTypeTable,
}));

vi.mock('../../../src/rollback/audit.js', () => ({
  createRollbackAudit: mockCreateRollbackAudit,
}));

vi.mock('../../../src/rollback/strategies/projected.js', () => ({
  executeProjected: mockExecuteProjected,
}));

vi.mock('../../../src/rollback/strategies/snapshot.js', () => ({
  executeSnapshot: mockExecuteSnapshot,
}));

vi.mock('../../../src/rollback/strategies/fill-only.js', () => ({
  executeFillOnly: mockExecuteFillOnly,
}));

vi.mock('../../../src/rollback/strategies/custom.js', () => ({
  executeCustom: mockExecuteCustom,
}));

vi.mock('../../../src/rollback/case-1-flow.js', () => ({
  rollbackCase1: mockRollbackCase1,
}));

// Phase 6 / CTX-01 — mock buildCtx so orchestrator tests don't need snapshot files on disk
vi.mock('../../../src/ctx/index.js', () => ({
  buildCtx: mockBuildCtx,
}));

// ---------------------------------------------------------------------------
// Actual imports (after mocks)
// ---------------------------------------------------------------------------

import { rollback } from '../../../src/rollback/orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(acquireWaitMs = 500) {
  return {
    lock: { acquireWaitMs, heartbeatMs: 30_000, staleThresholdMs: 14_400_000 },
    guard: { cacheTtlMs: 100, blockMode: 'all' as const },
    entities: [],
    migrations: '',
    region: undefined,
    tableName: 'test-table',
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  } as never;
}

function makeMigration() {
  return {
    id: 'test-migration-id',
    entityName: 'User',
    from: {} as never,
    to: {} as never,
    up: async (r: unknown) => ({ ...(r as object) }),
    down: async (r: unknown) => ({ ...(r as object) }),
  } as never;
}

function makeServiceStub() {
  return {} as never;
}

function makeArgs(overrides: {
  strategy?: 'projected' | 'snapshot' | 'fill-only' | 'custom';
  acquireWaitMs?: number;
  yes?: boolean;
  io?: { stderr?: { write: (s: string) => boolean }; confirm?: (prompt: string) => Promise<boolean> };
} = {}) {
  return {
    service: makeServiceStub(),
    config: makeConfig(overrides.acquireWaitMs),
    client: {} as never,
    tableName: 'test-table',
    migration: makeMigration(),
    strategy: overrides.strategy ?? 'projected',
    runId: 'run-001',
    holder: 'test-host:1234',
    ...(overrides.yes !== undefined ? { yes: overrides.yes } : {}),
    ...(overrides.io !== undefined ? { io: overrides.io } : {}),
  };
}

function makeAuditStub(overrides: Partial<{
  assertInvariantThrows: boolean;
  snapshot: Record<string, number>;
}> = {}) {
  const mockAssertInvariant = vi.fn(() => {
    if (overrides.assertInvariantThrows) {
      throw new Error('audit invariant violated');
    }
  });
  const snap = overrides.snapshot ?? { scanned: 1, reverted: 1, deleted: 0, skipped: 0, failed: 0 };
  const mockSnapshot = vi.fn(() => snap);
  const mockIncrementScanned = vi.fn();
  const mockIncrementSkipped = vi.fn();
  const mockIncrementFailed = vi.fn();
  const mockAddReverted = vi.fn();
  const mockAddDeleted = vi.fn();
  return {
    assertInvariant: mockAssertInvariant,
    snapshot: mockSnapshot,
    incrementScanned: mockIncrementScanned,
    incrementSkipped: mockIncrementSkipped,
    incrementFailed: mockIncrementFailed,
    addReverted: mockAddReverted,
    addDeleted: mockAddDeleted,
  };
}

function makeProceedDecision(lifecycleCase: 'case-1' | 'case-2' | 'case-3') {
  return { kind: 'proceed' as const, case: lifecycleCase, targetRow: { id: 'test-migration-id' } as never };
}

function makeRefuseDecision() {
  const err = new Error('preconditions refused');
  return { kind: 'refuse' as const, error: err };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rollback orchestrator (RBK-02..12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockRollbackCase1.mockResolvedValue({});
    mockExecuteProjected.mockResolvedValue(undefined);
    mockExecuteSnapshot.mockResolvedValue(undefined);
    mockExecuteFillOnly.mockResolvedValue(undefined);
    mockExecuteCustom.mockResolvedValue(undefined);
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    // Phase 6 / CTX-01 — buildCtx returns a fake ctx object
    mockBuildCtx.mockResolvedValue({ entity: vi.fn() });

    const defaultAudit = makeAuditStub();
    mockCreateRollbackAudit.mockReturnValue(defaultAudit);
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
  });

  // -------------------------------------------------------------------------
  // RB-01: Refusal path
  // -------------------------------------------------------------------------

  it('RB-01: refusal — checkPreconditions refuses; acquireLock NOT called; error thrown verbatim', async () => {
    const refuseErr = new Error('preconditions refused');
    mockCheckPreconditions.mockResolvedValue({ kind: 'refuse', error: refuseErr });

    const args = makeArgs();
    await expect(rollback(args)).rejects.toThrow('preconditions refused');

    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockStartLockHeartbeat).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockStopFn).not.toHaveBeenCalled();
    expect(mockTransitionToReleaseMode).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // RB-02: Order invariant
  // -------------------------------------------------------------------------

  it('RB-02: order — acquireLock → startLockHeartbeat → sleep → rollbackCase1 → audit.assertInvariant → transitionToReleaseMode', async () => {
    const audit = makeAuditStub();
    mockCreateRollbackAudit.mockReturnValue(audit);
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));

    const args = makeArgs();
    await rollback(args);

    const acquireOrder = mockAcquireLock.mock.invocationCallOrder[0]!;
    const heartbeatOrder = mockStartLockHeartbeat.mock.invocationCallOrder[0]!;
    const sleepOrder = mockSleep.mock.invocationCallOrder[0]!;
    const case1Order = mockRollbackCase1.mock.invocationCallOrder[0]!;
    const assertOrder = audit.assertInvariant.mock.invocationCallOrder[0]!;
    const transitionOrder = mockTransitionToReleaseMode.mock.invocationCallOrder[0]!;

    expect(acquireOrder).toBeLessThan(heartbeatOrder);
    expect(heartbeatOrder).toBeLessThan(sleepOrder);
    expect(sleepOrder).toBeLessThan(case1Order);
    expect(case1Order).toBeLessThan(assertOrder);
    expect(assertOrder).toBeLessThan(transitionOrder);
  });

  // -------------------------------------------------------------------------
  // RB-03: Sleep timing
  // -------------------------------------------------------------------------

  it('RB-03: sleep timing — sleep called with config.lock.acquireWaitMs', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
    const args = makeArgs({ acquireWaitMs: 300 });
    await rollback(args);
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(mockSleep).toHaveBeenCalledWith(300);
  });

  // -------------------------------------------------------------------------
  // RB-04: Case 1 dispatch
  // -------------------------------------------------------------------------

  it('RB-04: Case 1 dispatch — rollbackCase1 called; classifyTypeTable + executeProjected NOT called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
    const args = makeArgs();
    await rollback(args);
    expect(mockRollbackCase1).toHaveBeenCalledTimes(1);
    expect(mockClassifyTypeTable).not.toHaveBeenCalled();
    expect(mockExecuteProjected).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // RB-05..RB-09: Case 2/3 dispatch per strategy
  // -------------------------------------------------------------------------

  it('RB-05: Case 2 + projected — executeProjected called; others NOT called; classifyTypeTable called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const args = makeArgs({ strategy: 'projected' });
    await rollback(args);
    expect(mockClassifyTypeTable).toHaveBeenCalledTimes(1);
    expect(mockExecuteProjected).toHaveBeenCalledTimes(1);
    expect(mockExecuteSnapshot).not.toHaveBeenCalled();
    expect(mockExecuteFillOnly).not.toHaveBeenCalled();
    expect(mockExecuteCustom).not.toHaveBeenCalled();
    expect(mockRollbackCase1).not.toHaveBeenCalled();
  });

  it('RB-06: Case 2 + snapshot — executeSnapshot called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const args = makeArgs({ strategy: 'snapshot' });
    await rollback(args);
    expect(mockExecuteSnapshot).toHaveBeenCalledTimes(1);
    expect(mockExecuteProjected).not.toHaveBeenCalled();
    expect(mockExecuteFillOnly).not.toHaveBeenCalled();
    expect(mockExecuteCustom).not.toHaveBeenCalled();
  });

  it('RB-07: Case 2 + fill-only — executeFillOnly called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const args = makeArgs({ strategy: 'fill-only' });
    await rollback(args);
    expect(mockExecuteFillOnly).toHaveBeenCalledTimes(1);
    expect(mockExecuteProjected).not.toHaveBeenCalled();
    expect(mockExecuteSnapshot).not.toHaveBeenCalled();
    expect(mockExecuteCustom).not.toHaveBeenCalled();
  });

  it('RB-08: Case 2 + custom — executeCustom called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const args = makeArgs({ strategy: 'custom' });
    await rollback(args);
    expect(mockExecuteCustom).toHaveBeenCalledTimes(1);
    expect(mockExecuteProjected).not.toHaveBeenCalled();
    expect(mockExecuteSnapshot).not.toHaveBeenCalled();
    expect(mockExecuteFillOnly).not.toHaveBeenCalled();
  });

  it('RB-09: Case 3 + projected — executeProjected called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-3'));
    const args = makeArgs({ strategy: 'projected' });
    await rollback(args);
    expect(mockExecuteProjected).toHaveBeenCalledTimes(1);
    expect(mockClassifyTypeTable).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // RB-10: Strategy throw → markFailed
  // -------------------------------------------------------------------------

  it('RB-10: strategy throw → markFailed called; error re-thrown; sched.stop called', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const strategyError = new Error('strategy exploded');
    mockExecuteProjected.mockRejectedValueOnce(strategyError);
    const args = makeArgs({ strategy: 'projected' });

    await expect(rollback(args)).rejects.toThrow('strategy exploded');

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'run-001', migId: 'test-migration-id', cause: strategyError }),
    );
    expect(mockTransitionToReleaseMode).not.toHaveBeenCalled();
    expect(mockStopFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // RB-11: markFailed throws inside catch → original error still re-thrown, sched.stop still runs
  // -------------------------------------------------------------------------

  it('RB-11: markFailed throws inside catch — sched.stop still called; original error re-thrown', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const originalError = new Error('original strategy error');
    mockExecuteProjected.mockRejectedValueOnce(originalError);
    mockMarkFailed.mockRejectedValueOnce(new Error('markFailed itself failed'));

    const args = makeArgs({ strategy: 'projected' });
    const caught = await rollback(args).catch((e: unknown) => e);

    // Original error re-thrown (markFailed error is swallowed by .catch())
    expect(caught).toBe(originalError);
    // sched.stop still runs via finally{}
    expect(mockStopFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // RB-12: Audit invariant break → markFailed called; transitionToReleaseMode NOT called
  // -------------------------------------------------------------------------

  it('RB-12: audit invariant break — markFailed called; transitionToReleaseMode NOT called', async () => {
    const audit = makeAuditStub({ assertInvariantThrows: true });
    mockCreateRollbackAudit.mockReturnValue(audit);
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));

    const args = makeArgs({ strategy: 'projected' });
    await expect(rollback(args)).rejects.toThrow('audit invariant violated');

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockTransitionToReleaseMode).not.toHaveBeenCalled();
    expect(mockStopFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // RB-13: transitionToReleaseMode receives rollbackStrategy (Pitfall 9) — all 4 strategies
  // -------------------------------------------------------------------------

  it.each([
    ['projected'],
    ['snapshot'],
    ['fill-only'],
    ['custom'],
  ] as const)('RB-13: Pitfall 9 — transitionToReleaseMode receives rollbackStrategy=%s on success', async (strategy) => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const args = makeArgs({ strategy });
    await rollback(args);
    expect(mockTransitionToReleaseMode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rollbackStrategy: strategy }),
    );
  });

  // -------------------------------------------------------------------------
  // RB-14: Snapshot pass-through — yes:true and io passed to executeSnapshot
  // -------------------------------------------------------------------------

  it('RB-14: snapshot pass-through — yes:true and io are passed to executeSnapshot', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const io = { stderr: { write: vi.fn(() => true) }, confirm: vi.fn(async () => true) };
    const args = makeArgs({ strategy: 'snapshot', yes: true, io });

    await rollback(args);

    expect(mockExecuteSnapshot).toHaveBeenCalledTimes(1);
    const rawCallArgs = mockExecuteSnapshot.mock.calls[0] as unknown as [{ yes?: boolean; io?: unknown }];
    const callArgs = rawCallArgs[0];
    expect(callArgs.yes).toBe(true);
    expect(callArgs.io).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // RB-15: WARNING 4 — io.confirm reference equality
  // -------------------------------------------------------------------------

  it('RB-15: WARNING 4 — io.confirm reference equality when strategy=snapshot and yes is absent', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    const confirmFn = vi.fn(async (_prompt: string) => true);
    const io = { confirm: confirmFn };
    // No `yes` field — omit it (args.yes is undefined)
    const args = {
      service: makeServiceStub(),
      config: makeConfig(),
      client: {} as never,
      tableName: 'test-table',
      migration: makeMigration(),
      strategy: 'snapshot' as const,
      runId: 'run-001',
      holder: 'test-host:1234',
      io,
    };

    await rollback(args);

    expect(mockExecuteSnapshot).toHaveBeenCalledTimes(1);
    const rawCapturedArgs = mockExecuteSnapshot.mock.calls[0] as unknown as [{ io?: { confirm?: typeof confirmFn } }];
    const capturedArgs = rawCapturedArgs[0];
    // WARNING 4: the confirm function must be the EXACT same reference (not a copy or wrapper)
    expect(capturedArgs.io?.confirm).toBe(confirmFn);
  });

  // -------------------------------------------------------------------------
  // RB-16: acquireLock called with mode:'rollback' and correct migId/runId/holder
  // -------------------------------------------------------------------------

  it('RB-16: acquireLock called with mode:"rollback" and correct migId/runId/holder', async () => {
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
    const args = makeArgs();
    await rollback(args);
    expect(mockAcquireLock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: 'rollback', migId: 'test-migration-id', runId: 'run-001', holder: 'test-host:1234' }),
    );
  });

  // -------------------------------------------------------------------------
  // RB-17 (CTX-01): buildCtx only called for case-2/case-3; skipped for case-1
  // -------------------------------------------------------------------------

  it('RB-17: buildCtx NOT called for case-1; called once for case-2 (CTX-01 + RESEARCH §A6)', async () => {
    // Case 1: buildCtx must NOT be called (case-1 never calls down)
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
    await rollback(makeArgs());
    expect(mockBuildCtx).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockExecuteProjected.mockResolvedValue(undefined);
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    mockBuildCtx.mockResolvedValue({ entity: vi.fn() });
    mockCreateRollbackAudit.mockReturnValue(makeAuditStub());

    // Case 2: buildCtx MUST be called once with (migration, client, tableName, cwd)
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    await rollback(makeArgs({ strategy: 'projected' }));
    expect(mockBuildCtx).toHaveBeenCalledTimes(1);
    expect(mockBuildCtx).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'test-migration-id' }),
      expect.anything(),
      'test-table',
      expect.any(String),
    );
  });

  // -------------------------------------------------------------------------
  // RB-18 (CTX-01): ctx passed to projected/fill-only/custom; NOT to snapshot/case-1
  // -------------------------------------------------------------------------

  it('RB-18: ctx passed to executeProjected, executeFillOnly, executeCustom (CTX-01); NOT to executeSnapshot or rollbackCase1', async () => {
    const fakeCtxObject = { entity: vi.fn() };
    mockBuildCtx.mockResolvedValue(fakeCtxObject);

    // projected — ctx present
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    mockExecuteProjected.mockResolvedValue(undefined);
    await rollback(makeArgs({ strategy: 'projected' }));
    expect(mockExecuteProjected).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: fakeCtxObject }),
    );

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBuildCtx.mockResolvedValue(fakeCtxObject);
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    mockCreateRollbackAudit.mockReturnValue(makeAuditStub());

    // fill-only — ctx present
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    mockExecuteFillOnly.mockResolvedValue(undefined);
    await rollback(makeArgs({ strategy: 'fill-only' }));
    expect(mockExecuteFillOnly).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: fakeCtxObject }),
    );

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBuildCtx.mockResolvedValue(fakeCtxObject);
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    mockCreateRollbackAudit.mockReturnValue(makeAuditStub());

    // custom — ctx present
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    mockExecuteCustom.mockResolvedValue(undefined);
    await rollback(makeArgs({ strategy: 'custom' }));
    expect(mockExecuteCustom).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: fakeCtxObject }),
    );

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBuildCtx.mockResolvedValue(fakeCtxObject);
    mockClassifyTypeTable.mockReturnValue((async function* () {})());
    mockCreateRollbackAudit.mockReturnValue(makeAuditStub());

    // snapshot — ctx NOT present
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-2'));
    mockExecuteSnapshot.mockResolvedValue(undefined);
    await rollback(makeArgs({ strategy: 'snapshot' }));
    const snapshotCallArgs = mockExecuteSnapshot.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(snapshotCallArgs[0]).not.toHaveProperty('ctx');

    vi.clearAllMocks();
    mockAcquireLock.mockResolvedValue(undefined);
    mockMarkFailed.mockResolvedValue(undefined);
    mockTransitionToReleaseMode.mockResolvedValue(undefined);
    mockSleep.mockResolvedValue(undefined);
    mockStartLockHeartbeat.mockReturnValue({ stop: mockStopFn });
    mockStopFn.mockResolvedValue(undefined);
    mockBuildCtx.mockResolvedValue(fakeCtxObject);
    mockRollbackCase1.mockResolvedValue({});
    mockCreateRollbackAudit.mockReturnValue(makeAuditStub());

    // case-1 — rollbackCase1 args don't have ctx, buildCtx not called
    mockCheckPreconditions.mockResolvedValue(makeProceedDecision('case-1'));
    await rollback(makeArgs());
    expect(mockBuildCtx).not.toHaveBeenCalled();
    const case1CallArgs = mockRollbackCase1.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(case1CallArgs[0]).not.toHaveProperty('ctx');
  });
});
