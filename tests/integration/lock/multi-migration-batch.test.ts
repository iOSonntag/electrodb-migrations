/**
 * LCK-05 + LCK-09 — multi-migration release-mode handoff and inFlightIds-
 * non-empty release refusal against DDB Local.
 *
 * LCK-05 (release-mode handoff): the runner's apply-batch loop drops the lock
 * to `release` between migrations (`transitionToReleaseMode`) and resumes via
 * `appendInFlight` + a direct `lockState='apply'` flip. The lock is held
 * continuously across the boundary — no other runner can acquire because
 * `release` is OUTSIDE the takeover allowlist.
 *
 * Note on the `release → apply` step: there is no dedicated `state-mutations`
 * verb for this in Phase 3 (the runner's loop is Phase 4 territory). The test
 * uses a direct ElectroDB patch with the same WHERE preconditions
 * (`lockRunId = :runId AND lockState = 'release'`) the runner's hypothetical
 * verb would use. If a follow-on plan adds a `transitionFromReleaseToApply`
 * verb, this test should switch to it.
 *
 * LCK-09 (clear refused while inFlight non-empty): `clear`'s ConditionExpression
 * requires `attribute_not_exists(inFlightIds)`. DDB's set semantics make this
 * equivalent to `size(inFlightIds) = 0` (DDB removes empty sets), so leaving
 * a single migId in `inFlightIds` while in `release` state forces the clear
 * to fail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_SCHEMA_VERSION, MIGRATION_STATE_ID, createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock, readLockRow } from '../../../src/lock/index.js';
import { appendInFlight, clear, transitionToReleaseMode } from '../../../src/state-mutations/index.js';
import { bootstrapMigrationState, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const fastConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
} as never;

describe('LCK-05 + LCK-09: multi-migration batch handoff and inFlight-non-empty release refusal', () => {
  const tableName = randomTableName('lck-05-09');
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

  it('LCK-05: applies mig-1, transitions to release, re-acquires apply for mig-2, transitions release for mig-2, clears successfully', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const service = createMigrationsService(doc, tableName);
    // Pre-seed the two _migrations rows because transitionToReleaseMode's
    // item 1 patches them (ElectroDB patch requires the row to exist).
    for (const id of ['mig-1', 'mig-2']) {
      await service.migrations
        .put({
          id,
          schemaVersion: MIGRATIONS_SCHEMA_VERSION,
          kind: 'transform',
          status: 'pending',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          fingerprint: `fp-${id}`,
        })
        .go();
    }

    // Acquire mig-1 — lockState='apply', inFlightIds={mig-1}.
    await acquireLock(service, fastConfig, { mode: 'apply', migId: 'mig-1', runId: 'r-batch', holder: 'h' });
    expect((await readLockRow(service))?.lockState).toBe('apply');

    // Transition mig-1 → release. lockState='release', inFlightIds={}, releaseIds={mig-1}.
    await transitionToReleaseMode(service, { runId: 'r-batch', migId: 'mig-1', outcome: 'applied' });
    expect((await readLockRow(service))?.lockState).toBe('release');

    // Append mig-2 to inFlight while still in 'release'. lockMigrationId='mig-2',
    // inFlightIds={mig-2}.
    await appendInFlight(service, { runId: 'r-batch', migId: 'mig-2' });

    // Hand off back to apply via a direct patch — this is the LCK-05 release→apply
    // step (no dedicated state-mutations verb in Phase 3; Phase 4 may add one).
    // WHERE clause matches the same preconditions a verb would enforce.
    await service.migrationState
      .patch({ id: MIGRATION_STATE_ID })
      .set({ lockState: 'apply', heartbeatAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(({ lockRunId, lockState }, op) => `${op.eq(lockRunId, 'r-batch')} AND ${op.eq(lockState, 'release')}`)
      .go();
    const apply2 = await readLockRow(service);
    expect(apply2?.lockState).toBe('apply');
    expect(apply2?.lockMigrationId).toBe('mig-2');

    // Transition mig-2 → release. lockState='release', inFlightIds={}, releaseIds={mig-1,mig-2}.
    await transitionToReleaseMode(service, { runId: 'r-batch', migId: 'mig-2', outcome: 'applied' });
    expect((await readLockRow(service))?.lockState).toBe('release');

    // Now clear should succeed — lockState='release', lockRunId matches, inFlightIds is empty.
    await clear(service, { runId: 'r-batch' });
    expect((await readLockRow(service))?.lockState).toBe('free');
  }, 60_000);

  it('LCK-09: clear with non-empty inFlightIds throws (lock state remains release)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const tableName2 = randomTableName('lck-09');
    await createTestTable(raw, tableName2);
    await bootstrapMigrationState(doc, tableName2);
    try {
      const service = createMigrationsService(doc, tableName2);
      // Acquire writes inFlightIds={mig-stuck}, lockState='apply'.
      await acquireLock(service, fastConfig, { mode: 'apply', migId: 'mig-stuck', runId: 'r-stuck', holder: 'h' });
      // Force lockState='release' but DON'T touch inFlightIds — the LCK-09
      // condition `attribute_not_exists(inFlightIds)` should reject the clear.
      await service.migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: 'release', updatedAt: new Date().toISOString() }).go();
      // clear() must refuse — inFlightIds still contains 'mig-stuck'.
      await expect(clear(service, { runId: 'r-stuck' })).rejects.toBeDefined();
      const row = await readLockRow(service);
      // Lock state unchanged — clear was rejected.
      expect(row?.lockState).toBe('release');
      expect(row?.inFlightIds).toBeDefined();
    } finally {
      await deleteTestTable(raw, tableName2);
    }
  }, 30_000);
});
