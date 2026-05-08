/**
 * LCK-08 — `forceUnlock` state-aware truth table verified across all 7
 * `lockState` values against DDB Local.
 *
 * The truth table (mirrors `state-mutations/unlock.ts`):
 *
 * | priorState                                | action                                |
 * |-------------------------------------------|---------------------------------------|
 * | `apply`, `rollback`, `finalize`, `dying`  | markFailed → lockState='failed'       |
 * | `release`, `failed`                       | forced clear → lockState='free' (LCK-09 bypass) |
 * | `free`                                    | no-op; returns priorState='free'      |
 *
 * Each scenario uses its own ephemeral table so seeded state cannot leak
 * across cases. The four "active" cases re-use `acquireLock` to seed (so the
 * lock-row layout matches production), then patch `lockState` to the target
 * value when it differs from `apply`. The two "cleared" cases write the row
 * directly via the entity factory because there is no production path that
 * sits in `release` or `failed` until a state-mutation has run first.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock, forceUnlock, readLockRow } from '../../../src/lock/index.js';
import { bootstrapMigrationState, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const baseConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 1_000 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
} as never;

describe('LCK-08: forceUnlock state-aware truth table', () => {
  const { raw, doc } = makeDdbLocalClient();
  // One table per test for isolation — afterEach deletes whichever the test set.
  let currentTable: string | null = null;

  afterEach(async () => {
    if (currentTable) {
      await deleteTestTable(raw, currentTable);
      currentTable = null;
    }
  });

  for (const activeState of ['apply', 'rollback', 'finalize', 'dying'] as const) {
    it(`${activeState} → forceUnlock writes lockState='failed'`, async () => {
      const alive = await isDdbLocalReachable();
      if (!alive) {
        console.warn(skipMessage());
        return;
      }
      currentTable = randomTableName(`lck-08-${activeState}`);
      await createTestTable(raw, currentTable);
      await bootstrapMigrationState(doc, currentTable);
      const service = createMigrationsService(doc, currentTable);
      // Seed via acquireLock(mode='apply') so the row layout (composite-key
      // prefixes, ElectroDB identifier markers, inFlightIds) matches production.
      await acquireLock(service, baseConfig, { mode: 'apply', migId: `mig-${activeState}`, runId: `r-${activeState}`, holder: 'h' });
      // Patch lockState to the target if it differs from 'apply' (the seed value).
      if (activeState !== 'apply') {
        await service.migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: activeState }).go();
      }
      const result = await forceUnlock(service, { runId: `r-${activeState}` });
      expect(result.priorState).toBe(activeState);
      const row = await readLockRow(service);
      expect(row?.lockState).toBe('failed');
    }, 30_000);
  }

  for (const clearedState of ['release', 'failed'] as const) {
    it(`${clearedState} → forceUnlock clears to 'free'`, async () => {
      const alive = await isDdbLocalReachable();
      if (!alive) {
        console.warn(skipMessage());
        return;
      }
      currentTable = randomTableName(`lck-08-${clearedState}`);
      await createTestTable(raw, currentTable);
      const service = createMigrationsService(doc, currentTable);
      const now = new Date().toISOString();
      await service.migrationState
        .put({
          id: MIGRATION_STATE_ID,
          schemaVersion: STATE_SCHEMA_VERSION,
          updatedAt: now,
          lockState: clearedState,
          lockRunId: `r-${clearedState}`,
          lockHolder: 'h',
        })
        .go();
      const result = await forceUnlock(service, { runId: `r-${clearedState}` });
      expect(result.priorState).toBe(clearedState);
      const row = await readLockRow(service);
      expect(row?.lockState).toBe('free');
    }, 30_000);
  }

  it("free → forceUnlock returns priorState='free' without writing", async () => {
    const alive = await isDdbLocalReachable();
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    currentTable = randomTableName('lck-08-free');
    await createTestTable(raw, currentTable);
    const service = createMigrationsService(doc, currentTable);
    const result = await forceUnlock(service, { runId: 'never-existed' });
    expect(result.priorState).toBe('free');
    // The lock row should not exist (forceUnlock did not write).
    const row = await readLockRow(service);
    expect(row).toBeNull();
  }, 15_000);
});
