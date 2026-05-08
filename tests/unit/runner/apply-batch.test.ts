/**
 * Unit tests for `applyBatch` (AB-1 through AB-10).
 *
 * RUN-05: multi-migration loop with hand-off sequence.
 * RUN-06: per-entity sequence enforcement (--migration <id> filter).
 * RUN-07: empty pending list fast-path.
 * W-03: no-heartbeat-window safety invariant (AB-10).
 *
 * All verb modules are mocked so call ORDER and ARGUMENTS are observable
 * via `mock.invocationCallOrder`. Tests do NOT hit DDB Local — integration
 * coverage lives in Plan 14a (B-02 guarded-write-at-boundary).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyBatchArgs } from '../../../src/runner/apply-batch.js';
import { applyBatch } from '../../../src/runner/apply-batch.js';
import type { PendingMigration } from '../../../src/runner/load-pending.js';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock('../../../src/runner/apply-flow.js', () => ({
  applyFlow: vi.fn(),
  applyFlowScanWrite: vi.fn(),
}));

vi.mock('../../../src/runner/transition-release-to-apply.js', () => ({
  transitionReleaseToApply: vi.fn(),
}));

vi.mock('../../../src/state-mutations/index.js', () => ({
  appendInFlight: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock('../../../src/lock/index.js', () => ({
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
}));

// ---------------------------------------------------------------------------
// Import mocked functions for assertion
// ---------------------------------------------------------------------------

import { applyFlow, applyFlowScanWrite } from '../../../src/runner/apply-flow.js';
import { transitionReleaseToApply } from '../../../src/runner/transition-release-to-apply.js';
import { appendInFlight, markFailed } from '../../../src/state-mutations/index.js';
import { startLockHeartbeat } from '../../../src/lock/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_CONFIG = {
  lock: { heartbeatMs: 500, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: 'src/database/entities',
  tableName: 'test-table',
  remote: {},
} as never;

/** Minimal service stub — verbs are all mocked; bundle is never inspected. */
const STUB_SERVICE = {} as never;

const STUB_CLIENT = {} as never;

function makePending(
  id: string,
  entityName: string,
  fromVersion: string,
  toVersion: string,
): PendingMigration {
  return {
    id,
    entityName,
    fromVersion,
    toVersion,
    migration: { id, entityName, up: vi.fn(), down: vi.fn() } as never,
    path: `/fake/${id}/migration.ts`,
  };
}

function makeArgs(overrides: Partial<ApplyBatchArgs> = {}): ApplyBatchArgs {
  return {
    service: STUB_SERVICE,
    config: STUB_CONFIG,
    client: STUB_CLIENT,
    tableName: 'test-table',
    pending: [],
    runId: 'run-001',
    holder: 'host-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(applyFlow).mockResolvedValue({ itemCounts: { scanned: 0, migrated: 0, deleted: 0, skipped: 0, failed: 0 } });
  vi.mocked(applyFlowScanWrite).mockResolvedValue({ itemCounts: { scanned: 0, migrated: 0, deleted: 0, skipped: 0, failed: 0 } });
  vi.mocked(transitionReleaseToApply).mockResolvedValue(undefined);
  vi.mocked(appendInFlight).mockResolvedValue(undefined);
  vi.mocked(markFailed).mockResolvedValue(undefined);
  vi.mocked(startLockHeartbeat).mockReturnValue({ stop: vi.fn(async () => {}) });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyBatch', () => {
  it('AB-1: empty pending → {applied: []}; no verb is invoked', async () => {
    const result = await applyBatch(makeArgs({ pending: [] }));

    expect(result).toEqual({ applied: [] });
    expect(applyFlow).not.toHaveBeenCalled();
    expect(applyFlowScanWrite).not.toHaveBeenCalled();
    expect(transitionReleaseToApply).not.toHaveBeenCalled();
    expect(appendInFlight).not.toHaveBeenCalled();
  });

  it('AB-2: single pending, no migrationId — applyFlow called once; scan-write verbs NOT called', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const result = await applyBatch(makeArgs({ pending: [mig1] }));

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.migId).toBe('mig-1');
    expect(applyFlow).toHaveBeenCalledTimes(1);
    expect(applyFlow).toHaveBeenCalledWith(
      expect.objectContaining({ migration: mig1.migration, runId: 'run-001' }),
    );
    expect(applyFlowScanWrite).not.toHaveBeenCalled();
    expect(transitionReleaseToApply).not.toHaveBeenCalled();
    expect(appendInFlight).not.toHaveBeenCalled();
  });

  it('AB-3: two pending — applyFlow(mig-1) → appendInFlight(mig-2) → transitionReleaseToApply(mig-2) → applyFlowScanWrite(mig-2)', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const mig2 = makePending('mig-2', 'User', '2', '3');

    const result = await applyBatch(makeArgs({ pending: [mig1, mig2] }));

    expect(result.applied).toHaveLength(2);

    // Call ORDER via invocationCallOrder
    const applyFlowOrder = vi.mocked(applyFlow).mock.invocationCallOrder[0]!;
    const appendInFlightOrder = vi.mocked(appendInFlight).mock.invocationCallOrder[0]!;
    const transitionOrder = vi.mocked(transitionReleaseToApply).mock.invocationCallOrder[0]!;
    const scanWriteOrder = vi.mocked(applyFlowScanWrite).mock.invocationCallOrder[0]!;

    expect(applyFlowOrder).toBeLessThan(appendInFlightOrder);
    expect(appendInFlightOrder).toBeLessThan(transitionOrder);
    expect(transitionOrder).toBeLessThan(scanWriteOrder);

    // Arguments
    expect(appendInFlight).toHaveBeenCalledWith(STUB_SERVICE, { runId: 'run-001', migId: 'mig-2' });
    expect(transitionReleaseToApply).toHaveBeenCalledWith(STUB_SERVICE, { runId: 'run-001', migId: 'mig-2' });
    expect(applyFlowScanWrite).toHaveBeenCalledWith(
      expect.objectContaining({ migration: mig2.migration, runId: 'run-001' }),
    );
  });

  it('AB-4: migrationId is the next pending — only applyFlow called; result has 1 entry', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const mig2 = makePending('mig-2', 'User', '2', '3');

    const result = await applyBatch(makeArgs({ pending: [mig1, mig2], migrationId: 'mig-1' }));

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.migId).toBe('mig-1');
    expect(applyFlow).toHaveBeenCalledTimes(1);
    expect(applyFlowScanWrite).not.toHaveBeenCalled();
    expect(transitionReleaseToApply).not.toHaveBeenCalled();
  });

  it('AB-5: migrationId is NOT the next pending — throws EDB_NOT_NEXT_PENDING with remediation; NO verbs invoked', async () => {
    const userStatus = makePending('User-add-status', 'User', '1', '2');
    const userTier = makePending('User-add-tier', 'User', '2', '3');
    // pending sorted: [User-add-status (next), User-add-tier]

    const err = await applyBatch(makeArgs({ pending: [userStatus, userTier], migrationId: 'User-add-tier' }))
      .then(() => null)
      .catch((e: Error & { code?: string; remediation?: string }) => e);

    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe('EDB_NOT_NEXT_PENDING');
    expect((err as { remediation?: string }).remediation).toContain('Next pending: User-add-status');
    expect((err as { remediation?: string }).remediation).toContain('User v1→v2');

    expect(applyFlow).not.toHaveBeenCalled();
    expect(applyFlowScanWrite).not.toHaveBeenCalled();
    expect(transitionReleaseToApply).not.toHaveBeenCalled();
    expect(appendInFlight).not.toHaveBeenCalled();
  });

  it('AB-6: migrationId is unknown (not in pending list) — throws EDB_NOT_PENDING; NO verbs invoked', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');

    const err = await applyBatch(makeArgs({ pending: [mig1], migrationId: 'mig-unknown' }))
      .then(() => null)
      .catch((e: Error & { code?: string }) => e);

    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe('EDB_NOT_PENDING');

    expect(applyFlow).not.toHaveBeenCalled();
    expect(applyFlowScanWrite).not.toHaveBeenCalled();
  });

  it('AB-7: per-entity sequence (Open Question 6) — User-add-status is next for User entity even though Team-add-X is first globally', async () => {
    // Team comes before User alphabetically — Team-add-X is first in sorted list.
    const teamAddX = makePending('Team-add-X', 'Team', '1', '2');
    const userAddStatus = makePending('User-add-status', 'User', '1', '2');
    // pending = [Team-add-X, User-add-status]

    // User-add-status is next FOR USER entity — should be valid even though Team-add-X is first globally.
    const result = await applyBatch(
      makeArgs({ pending: [teamAddX, userAddStatus], migrationId: 'User-add-status' }),
    );

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.migId).toBe('User-add-status');
    expect(applyFlow).toHaveBeenCalledTimes(1);
    expect(applyFlow).toHaveBeenCalledWith(
      expect.objectContaining({ migration: userAddStatus.migration }),
    );
  });

  it('AB-8: migration 2 fails — markFailed called with {runId, migId: mig-2, cause}; sched.stop runs; original error re-thrown', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const mig2 = makePending('mig-2', 'User', '2', '3');
    const boom = new Error('scan exploded');
    vi.mocked(applyFlowScanWrite).mockRejectedValueOnce(boom);

    const stopSpy = vi.fn(async () => {});
    vi.mocked(startLockHeartbeat).mockReturnValue({ stop: stopSpy });

    const err = await applyBatch(makeArgs({ pending: [mig1, mig2] })).catch((e) => e);

    expect(err).toBe(boom);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(STUB_SERVICE, {
      runId: 'run-001',
      migId: 'mig-2',
      cause: boom,
    });
    expect(stopSpy).toHaveBeenCalledTimes(1);
    // applyFlow for mig-1 was successful
    expect(applyFlow).toHaveBeenCalledTimes(1);
  });

  it('AB-9: heartbeat scheduler started by applyBatch exactly once for two pending (around migration 2)', async () => {
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const mig2 = makePending('mig-2', 'User', '2', '3');

    await applyBatch(makeArgs({ pending: [mig1, mig2] }));

    // applyBatch calls startLockHeartbeat once for mig-2.
    // applyFlow's call to startLockHeartbeat happens INSIDE the mocked applyFlow (we don't see it).
    expect(vi.mocked(startLockHeartbeat).mock.calls.length).toBe(1);
    expect(vi.mocked(startLockHeartbeat)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-001', migId: 'mig-2' }),
    );
  });

  it('AB-10 (W-03): heartbeat restarts BEFORE appendInFlight/transitionReleaseToApply, ensuring the no-heartbeat window only spans the release→release window (release IS NOT in the stale-takeover allowlist, so the gap is safe)', async () => {
    // The W-03 invariant rests on `release` being takeover-immune. See
    // src/guard/lock-state-set.ts: GATING_LOCK_STATES contains 'release'
    // (gates app traffic) AND Phase 3 LCK-03 stale-takeover allowlist EXCLUDES
    // 'release' (no other runner can grab the lock from us during the window).
    const mig1 = makePending('mig-1', 'User', '1', '2');
    const mig2 = makePending('mig-2', 'User', '2', '3');

    await applyBatch(makeArgs({ pending: [mig1, mig2] }));

    // Assert EXACT call ordering using invocationCallOrder:
    // 1. applyFlow(mig-1) resolves — lock is now in 'release' (production reality)
    // 2. startLockHeartbeat({migId: 'mig-2'}) — heartbeat restarts FIRST
    // 3. appendInFlight({migId: 'mig-2'}) — lockState still 'release' here
    // 4. transitionReleaseToApply({migId: 'mig-2'}) — lockState flips to 'apply' here
    // 5. applyFlowScanWrite(mig-2) — runs under 'apply' state with fresh heartbeat
    const applyFlowCallOrder = vi.mocked(applyFlow).mock.invocationCallOrder[0]!;
    const heartbeatCallOrder = vi.mocked(startLockHeartbeat).mock.invocationCallOrder[0]!;
    const appendInFlightCallOrder = vi.mocked(appendInFlight).mock.invocationCallOrder[0]!;
    const transitionCallOrder = vi.mocked(transitionReleaseToApply).mock.invocationCallOrder[0]!;
    const scanWriteCallOrder = vi.mocked(applyFlowScanWrite).mock.invocationCallOrder[0]!;

    expect(applyFlowCallOrder).toBeLessThan(heartbeatCallOrder);
    expect(heartbeatCallOrder).toBeLessThan(appendInFlightCallOrder);
    expect(appendInFlightCallOrder).toBeLessThan(transitionCallOrder);
    expect(transitionCallOrder).toBeLessThan(scanWriteCallOrder);
  });
});
