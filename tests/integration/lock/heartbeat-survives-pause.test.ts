/**
 * LCK-02 + LCK-10 — heartbeat scheduling and 2-failure abort against DDB Local.
 *
 * Two scenarios:
 *  - Happy path: `startLockHeartbeat` advances `heartbeatAt` once per
 *    `heartbeatMs` and stops cleanly via `scheduler.stop()`.
 *  - Abort path: when consecutive heartbeat writes fail their
 *    ConditionExpression, the scheduler aborts after
 *    `maxConsecutiveFailures` (default 2) and the `onAbort` callback runs
 *    `markFailed` which lands `lockState='failed'` and `_migration_runs.status='failed'`.
 *
 * Failure injection: rather than corrupt `lockRunId` (which would also block
 * `markFailed` — its where-clause is also `lockRunId = :runId`), the test
 * patches `lockState` to `'release'`. That state is OUTSIDE the heartbeat's
 * active-state filter `(apply|rollback|finalize|dying)` so the heartbeat
 * condition fails, but `markFailed`'s ConditionExpression is satisfied
 * (only `lockRunId` is checked) so the abort path can land `lockState='failed'`
 * deterministically.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_STATE_ID, createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock, readLockRow, startLockHeartbeat } from '../../../src/lock/index.js';
import { bootstrapMigrationState, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

// Fast heartbeat for tight test loops; staleThreshold is left long so
// stale-takeover never fires accidentally during these scenarios.
const fastConfig = {
  lock: { heartbeatMs: 200, staleThresholdMs: 60_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
} as never;

describe('LCK-02 + LCK-10: heartbeat scheduling and abort', () => {
  const tableName = randomTableName('lck-02-10');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      await createTestTable(raw, tableName);
      await bootstrapMigrationState(doc, tableName);
    }
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('heartbeat advances heartbeatAt every interval and stops cleanly', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const service = createMigrationsService(doc, tableName);
    await acquireLock(service, fastConfig, { mode: 'apply', migId: 'mig-hb', runId: 'r-hb', holder: 'h' });
    const initial = await readLockRow(service);
    const sched = startLockHeartbeat({ service, config: fastConfig, runId: 'r-hb' });
    // 700ms ≥ 3 * 200ms so the scheduler has fired at least 3 times.
    await new Promise((r) => setTimeout(r, 700));
    const advanced = await readLockRow(service);
    expect(advanced?.heartbeatAt).toBeDefined();
    expect(advanced?.heartbeatAt).not.toBe(initial?.heartbeatAt);
    await sched.stop();
    const afterStop = await readLockRow(service);
    // No further ticks after stop — wait one more interval, heartbeatAt unchanged.
    await new Promise((r) => setTimeout(r, 400));
    const finalRead = await readLockRow(service);
    expect(finalRead?.heartbeatAt).toBe(afterStop?.heartbeatAt);
  }, 30_000);

  it('aborts and marks lockState=failed after 2 consecutive heartbeat write failures', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Use a fresh table for the failure scenario so the prior test's lock
    // state cannot influence this run.
    const tableName2 = randomTableName('lck-10');
    await createTestTable(raw, tableName2);
    await bootstrapMigrationState(doc, tableName2);
    try {
      const service = createMigrationsService(doc, tableName2);
      await acquireLock(service, fastConfig, { mode: 'apply', migId: 'mig-hb-fail', runId: 'r-hb-fail', holder: 'h' });
      const sched = startLockHeartbeat({ service, config: fastConfig, runId: 'r-hb-fail', migId: 'mig-hb-fail' });
      // Invalidate the heartbeat's active-state filter (apply|rollback|finalize|dying)
      // by patching lockState to 'release' — heartbeat ConditionExpression now fails
      // every tick. lockRunId is left intact so the onAbort markFailed succeeds.
      await service.migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: 'release' }).go();
      // Wait for 2 consecutive failures (≥ 2 * 200ms = 400ms) plus margin for
      // the scheduler's onAbort markFailed transactWrite to land.
      await new Promise((r) => setTimeout(r, 1_500));
      const finalRow = await readLockRow(service);
      expect(finalRow?.lockState).toBe('failed');
      await sched.stop();
    } finally {
      await deleteTestTable(raw, tableName2);
    }
  }, 30_000);
});
