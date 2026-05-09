import { describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { type AcquireArgs, acquire } from '../../../src/state-mutations/acquire.js';

const baseConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 15_000 },
  guard: { cacheTtlMs: 5_000, blockMode: 'all' as const },
} as ResolvedConfig;

const baseArgs: AcquireArgs = {
  mode: 'apply',
  migId: 'mig-1',
  runId: 'run-1',
  holder: 'host-A',
};

/**
 * Builds a stub `MigrationsServiceBundle` that records every transactWrite
 * call. The stub returns tagged sentinel values from each chained method so
 * the test can assert SHAPE (item count, order, set fields, where-clause body)
 * without a real DDB roundtrip.
 *
 * Plan 06 covers the integration tests with real DDB (Local) and asserts the
 * actual rendered ConditionExpression strings.
 */
function makeStubService(transactionGoImpl?: () => Promise<unknown>) {
  // Capture every operation invoked inside the transactWrite callback.
  type Captured = {
    kind: '_migration_state' | '_migrations' | '_migration_runs';
    op: 'patch' | 'put' | 'update';
    set?: Record<string, unknown>;
    add?: Record<string, unknown>;
    delete?: Record<string, unknown>;
    remove?: readonly string[];
    put?: Record<string, unknown>;
    whereCondition?: string;
    commitOptions?: Record<string, unknown>;
  };
  const captured: Captured[] = [];

  // Stub `op` mirrors ElectroDB's where-callback `op` — each method returns a
  // tagged string so the test can assert which operators appeared in the
  // composed condition. Real ElectroDB renders these via attribute-name maps;
  // the unit test only needs to see the verb invocations.
  const stubOp = {
    notExists: (a: string) => `notExists(${a})`,
    exists: (a: string) => `exists(${a})`,
    eq: (a: string, v: unknown) => `eq(${a},${JSON.stringify(v)})`,
    ne: (a: string, v: unknown) => `ne(${a},${JSON.stringify(v)})`,
    lt: (a: string, v: unknown) => `lt(${a},${JSON.stringify(v)})`,
    gt: (a: string, v: unknown) => `gt(${a},${JSON.stringify(v)})`,
    contains: (a: unknown, v: unknown) => `contains(${JSON.stringify(a)},${JSON.stringify(v)})`,
    size: (a: string) => `size(${a})`,
    value: (_a: string, v: unknown) => v,
  };
  // Stub attribute names — ElectroDB normally renders these as `#attr` etc.
  // For testing we just pass the literal attribute name through.
  const stubAttrs = new Proxy(
    {},
    {
      get: (_target, prop) => prop,
    },
  ) as Record<string, string>;

  function makeEntityStub(kind: Captured['kind']) {
    function stubPatchChain(builder: Captured): unknown {
      const chain = {
        set(values: Record<string, unknown>) {
          builder.set = { ...(builder.set ?? {}), ...values };
          return chain;
        },
        add(values: Record<string, unknown>) {
          builder.add = { ...(builder.add ?? {}), ...values };
          return chain;
        },
        delete(values: Record<string, unknown>) {
          builder.delete = { ...(builder.delete ?? {}), ...values };
          return chain;
        },
        remove(attrs: readonly string[]) {
          builder.remove = attrs;
          return chain;
        },
        where(cb: (attrs: typeof stubAttrs, op: typeof stubOp) => string) {
          builder.whereCondition = cb(stubAttrs, stubOp);
          return chain;
        },
        commit(options?: Record<string, unknown>) {
          if (options !== undefined) builder.commitOptions = options;
          captured.push(builder);
          return builder;
        },
      };
      return chain;
    }
    function stubPutChain(builder: Captured): unknown {
      const chain = {
        commit(options?: Record<string, unknown>) {
          if (options !== undefined) builder.commitOptions = options;
          captured.push(builder);
          return builder;
        },
      };
      return chain;
    }

    return {
      patch: (_id: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'patch' };
        return stubPatchChain(builder);
      },
      put: (values: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'put', put: values };
        return stubPutChain(builder);
      },
      update: (_id: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'update' };
        return stubPatchChain(builder);
      },
    };
  }

  const goSpy = vi.fn(async () => (transactionGoImpl ? transactionGoImpl() : {}));
  const writeFn = vi.fn((callback: (entities: Record<string, unknown>) => readonly Captured[]) => {
    const items = callback({
      migrationState: makeEntityStub('_migration_state'),
      migrations: makeEntityStub('_migrations'),
      migrationRuns: makeEntityStub('_migration_runs'),
    });
    // Force-evaluate items so each commit() runs and pushes to captured.
    // (callback's array drives evaluation already; this is for safety.)
    void items.length;
    return { go: goSpy };
  });

  const service = {
    service: { transaction: { write: writeFn } },
    migrations: makeEntityStub('_migrations') as never,
    migrationState: makeEntityStub('_migration_state') as never,
    migrationRuns: makeEntityStub('_migration_runs') as never,
  };

  return { service, captured, writeFn, goSpy };
}

describe('state-mutations.acquire (LCK-01, LCK-03 conditional shape)', () => {
  it('emits exactly one transactWrite of 2 items', async () => {
    const { service, captured, writeFn, goSpy } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(2);
  });

  it('item 0 mutates _migration_state and item 1 puts _migration_runs (Pitfall #7 item ordering)', async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    expect(captured[0]?.kind).toBe('_migration_state');
    expect(captured[0]?.op).toBe('patch');
    expect(captured[1]?.kind).toBe('_migration_runs');
    expect(captured[1]?.op).toBe('put');
  });

  it('item 0 sets the canonical lock-row fields plus inFlightIds += migId', async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    const state = captured[0];
    expect(state?.set).toMatchObject({
      lockState: 'apply',
      lockHolder: 'host-A',
      lockRunId: 'run-1',
      lockMigrationId: 'mig-1',
      schemaVersion: 1,
    });
    expect(state?.set).toHaveProperty('lockAcquiredAt');
    expect(state?.set).toHaveProperty('heartbeatAt');
    expect(state?.set).toHaveProperty('updatedAt');
    expect(state?.add).toEqual({ inFlightIds: ['mig-1'] });
  });

  it('item 1 puts the run row with status=running and matching command/migration/runId', async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    expect(captured[1]?.put).toMatchObject({
      runId: 'run-1',
      command: 'apply',
      status: 'running',
      migrationId: 'mig-1',
      startedBy: 'host-A',
      schemaVersion: 1,
    });
    expect(captured[1]?.put).toHaveProperty('startedAt');
  });

  it('item 0 ConditionExpression covers all four active states + free + notExists', async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    const condition = captured[0]?.whereCondition ?? '';
    // notExists branch (fresh row, never bootstrapped)
    expect(condition).toContain('notExists(lockState)');
    // free branch (steady-state idle)
    expect(condition).toContain('eq(lockState,"free")');
    // stale-takeover state filter — all four active states must be admitted
    expect(condition).toContain('"apply"');
    expect(condition).toContain('"rollback"');
    expect(condition).toContain('"finalize"');
    expect(condition).toContain('"dying"');
    // heartbeatAt staleness check
    expect(condition).toContain('lt(heartbeatAt,');
  });

  it('item 0 ConditionExpression does NOT admit release or failed for takeover (LCK-03)', async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    const condition = captured[0]?.whereCondition ?? '';
    // 'release' and 'failed' must not be in the takeover state filter — they
    // require an explicit unlock per LCK-08.
    // The literal `"release"` may appear elsewhere only if a future code path
    // adds it; for this test we assert ABSENCE of takeover-style enumeration.
    expect(condition).not.toContain('eq(lockState,"release")');
    expect(condition).not.toContain('eq(lockState,"failed")');
  });

  it("item 0 commits with response='all_old' (ElectroDB's surface for ReturnValuesOnConditionCheckFailure)", async () => {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, baseArgs);

    expect(captured[0]?.commitOptions).toMatchObject({ response: 'all_old' });
  });

  it('throws EDBMigrationLockHeldError when transactWrite is cancelled with ConditionalCheckFailed on item 0', async () => {
    const cancelled = Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        {
          Code: 'ConditionalCheckFailed',
          Item: {
            lockState: 'apply',
            lockHolder: 'other-host',
            lockRunId: 'other-run',
            heartbeatAt: '2026-01-01T00:00:00.000Z',
          },
        },
        { Code: 'None' },
      ],
    });
    const { service } = makeStubService(async () => {
      throw cancelled;
    });
    await expect(acquire(service as never, baseConfig, baseArgs)).rejects.toMatchObject({
      code: 'EDB_MIGRATION_LOCK_HELD',
      details: expect.objectContaining({
        currentLockHolder: 'other-host',
        currentRunId: 'other-run',
        currentLockState: 'apply',
      }),
    });
  });

  it('throws EDBMigrationLockHeldError with empty details when ALL_OLD is unavailable', async () => {
    const cancelled = Object.assign(new Error('Transaction cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    const { service } = makeStubService(async () => {
      throw cancelled;
    });
    let caught: unknown;
    try {
      await acquire(service as never, baseConfig, baseArgs);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'EDB_MIGRATION_LOCK_HELD' });
  });

  it('rethrows non-cancellation errors verbatim (no wrapping)', async () => {
    const networkErr = new Error('ECONNRESET');
    const { service } = makeStubService(async () => {
      throw networkErr;
    });
    await expect(acquire(service as never, baseConfig, baseArgs)).rejects.toBe(networkErr);
  });

  it('staleCutoff in ConditionExpression is derived from config.lock.staleThresholdMs', async () => {
    const { service, captured } = makeStubService();
    const before = Date.now();
    await acquire(service as never, baseConfig, baseArgs);
    const after = Date.now();

    const condition = captured[0]?.whereCondition ?? '';
    const m = condition.match(/lt\(heartbeatAt,"([^"]+)"\)/);
    expect(m).not.toBeNull();
    const cutoffIso = m?.[1] ?? '';
    const cutoffMs = new Date(cutoffIso).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - baseConfig.lock.staleThresholdMs);
    expect(cutoffMs).toBeLessThanOrEqual(after - baseConfig.lock.staleThresholdMs);
  });
});

/**
 * OQ9 regression tests — parameterized over (mode × lockState).
 *
 * Purpose: verify that:
 * 1. Apply-mode ConditionExpression is UNCHANGED (no `release` or `failed`).
 * 2. Rollback-mode ConditionExpression is WIDENED (includes `release` AND `failed`).
 * 3. Both modes still include all four stale-takeover states.
 *
 * These are STATIC WHERE-CLAUSE STRING assertions — no DDB roundtrip needed.
 * The stub captures the rendered condition so tests can inspect which operators
 * appear inside the composed expression.
 *
 * See src/state-mutations/acquire.ts for the full OQ9 design rationale.
 */
describe('OQ9 — mode-aware ConditionExpression (apply mode UNCHANGED, rollback mode WIDENED)', () => {
  // ---------------------------------------------------------------------------
  // Helper to capture the where condition for a given mode.
  // ---------------------------------------------------------------------------
  async function captureCondition(mode: 'apply' | 'rollback' | 'finalize'): Promise<string> {
    const { service, captured } = makeStubService();
    await acquire(service as never, baseConfig, { ...baseArgs, mode });
    return captured[0]?.whereCondition ?? '';
  }

  // ---------------------------------------------------------------------------
  // Apply mode — UNCHANGED (no release, no failed in non-stale branches)
  // ---------------------------------------------------------------------------
  describe('mode: apply (UNCHANGED)', () => {
    it('apply-mode condition contains notExists(lockState)', async () => {
      const condition = await captureCondition('apply');
      expect(condition).toContain('notExists(lockState)');
    });

    it('apply-mode condition contains eq(lockState,"free")', async () => {
      const condition = await captureCondition('apply');
      expect(condition).toContain('eq(lockState,"free")');
    });

    it('apply-mode condition contains all four stale-takeover states', async () => {
      const condition = await captureCondition('apply');
      expect(condition).toContain('"apply"');
      expect(condition).toContain('"rollback"');
      expect(condition).toContain('"finalize"');
      expect(condition).toContain('"dying"');
    });

    it('apply-mode condition does NOT contain eq(lockState,"release") (LCK-03)', async () => {
      const condition = await captureCondition('apply');
      expect(condition).not.toContain('eq(lockState,"release")');
    });

    it('apply-mode condition does NOT contain eq(lockState,"failed") (LCK-03)', async () => {
      const condition = await captureCondition('apply');
      expect(condition).not.toContain('eq(lockState,"failed")');
    });

    it('apply-mode smoke: acquire succeeds and emits 2-item transact (no regression)', async () => {
      const { service, captured, writeFn, goSpy } = makeStubService();
      await acquire(service as never, baseConfig, { ...baseArgs, mode: 'apply' });
      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(goSpy).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Rollback mode — OQ9 WIDENED (includes release and failed)
  // ---------------------------------------------------------------------------
  describe('mode: rollback (OQ9 WIDENED)', () => {
    it('rollback-mode condition contains notExists(lockState)', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('notExists(lockState)');
    });

    it('rollback-mode condition contains eq(lockState,"free")', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('eq(lockState,"free")');
    });

    it('rollback-mode condition contains eq(lockState,"release") [OQ9 NEW]', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('eq(lockState,"release")');
    });

    it('rollback-mode condition contains eq(lockState,"failed") [OQ9 NEW]', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('eq(lockState,"failed")');
    });

    it('rollback-mode condition contains all four stale-takeover states (including stale rollback = takeover)', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('"apply"');
      expect(condition).toContain('"rollback"');
      expect(condition).toContain('"finalize"');
      expect(condition).toContain('"dying"');
    });

    it('rollback-mode condition contains heartbeatAt staleness check', async () => {
      const condition = await captureCondition('rollback');
      expect(condition).toContain('lt(heartbeatAt,');
    });

    it('rollback-mode smoke: acquire succeeds and emits 2-item transact', async () => {
      const { service, captured, writeFn, goSpy } = makeStubService();
      await acquire(service as never, baseConfig, { ...baseArgs, mode: 'rollback' });
      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(goSpy).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
    });

    it('rollback-mode: item 0 sets lockState to "rollback"', async () => {
      const { service, captured } = makeStubService();
      await acquire(service as never, baseConfig, { ...baseArgs, mode: 'rollback' });
      expect(captured[0]?.set).toMatchObject({ lockState: 'rollback' });
    });

    it('rollback-mode throws EDBMigrationLockHeldError on ConditionalCheckFailed (behavioral smoke)', async () => {
      const cancelled = Object.assign(new Error('Transaction cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      });
      const { service } = makeStubService(async () => { throw cancelled; });
      await expect(
        acquire(service as never, baseConfig, { ...baseArgs, mode: 'rollback' }),
      ).rejects.toMatchObject({ code: 'EDB_MIGRATION_LOCK_HELD' });
    });
  });

  // ---------------------------------------------------------------------------
  // Finalize mode — same as apply (unchanged)
  // ---------------------------------------------------------------------------
  describe('mode: finalize (same as apply — unchanged)', () => {
    it('finalize-mode condition does NOT contain eq(lockState,"release")', async () => {
      const condition = await captureCondition('finalize');
      expect(condition).not.toContain('eq(lockState,"release")');
    });

    it('finalize-mode condition does NOT contain eq(lockState,"failed")', async () => {
      const condition = await captureCondition('finalize');
      expect(condition).not.toContain('eq(lockState,"failed")');
    });

    it('finalize-mode smoke: acquire succeeds and emits 2-item transact', async () => {
      const { service, captured } = makeStubService();
      await acquire(service as never, baseConfig, { ...baseArgs, mode: 'finalize' });
      expect(captured).toHaveLength(2);
    });
  });
});
