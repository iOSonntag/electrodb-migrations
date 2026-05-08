/**
 * LCK-03 — stale-takeover state filter against a real DDB Local table.
 *
 * Proves the takeover ConditionExpression on `state-mutations.acquire`:
 *   `(lockState IN ('apply','rollback','finalize','dying')) AND heartbeatAt < :staleCutoff`
 * Specifically:
 *  - `apply` with stale heartbeat → takeover ALLOWED.
 *  - `release` (regardless of heartbeat freshness) → takeover REJECTED.
 *  - `failed` → takeover REJECTED — the operator must explicitly `unlock`.
 *
 * `release`/`failed` are intentionally outside the takeover allowlist; only
 * the four active lock states (`apply`/`rollback`/`finalize`/`dying`) admit
 * a takeover, and only when the heartbeat is older than `staleThresholdMs`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { type SeedLockState, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

// staleThresholdMs=1s lets the test seed a 60s-old heartbeat then sleep 1.5s
// to make the runner's runtime cutoff fire. The acquire wait is short so the
// takeover branch is exercised quickly.
const baseConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 1_000, acquireWaitMs: 15_000 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
} as never;

/**
 * Seed `_migration_state` with a specific `lockState` and `heartbeatAt`.
 * Uses the framework's own entity factory so the row layout (composite-key
 * prefixes, ElectroDB identifier markers) matches what production writes
 * would produce.
 */
async function seedLockState(doc: ReturnType<typeof makeDdbLocalClient>['doc'], tableName: string, lockState: SeedLockState, heartbeatAt: string): Promise<void> {
  const bundle = createMigrationsService(doc, tableName);
  await bundle.migrationState
    .put({
      id: MIGRATION_STATE_ID,
      schemaVersion: STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      lockState,
      lockHolder: 'old-runner',
      lockRunId: 'r-old',
      lockMigrationId: 'mig-old',
      lockAcquiredAt: new Date(Date.now() - 60_000).toISOString(),
      heartbeatAt,
      inFlightIds: ['mig-old'],
    })
    .go();
}

describe('LCK-03: stale-takeover state filter', () => {
  const tableName = randomTableName('lck-03');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('TAKEOVER ALLOWED: lockState=apply with stale heartbeatAt → new acquire succeeds', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString(); // 60s ago, > staleThresholdMs=1s
    await seedLockState(doc, tableName, 'apply', staleHeartbeat);
    // Sleep ensures the cutoff window fires AT runtime — the cutoff is computed
    // inside state-mutations.acquire as `Date.now() - staleThresholdMs` so the
    // seeded 60s-old timestamp is older than the runtime cutoff regardless.
    await new Promise((r) => setTimeout(r, 1_500));
    const service = createMigrationsService(doc, tableName);
    await expect(
      acquireLock(service, baseConfig, {
        mode: 'apply',
        migId: 'mig-new',
        runId: 'r-new',
        holder: 'host-new',
      }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it('TAKEOVER REJECTED: lockState=release (regardless of heartbeatAt freshness) → throws EDBMigrationLockHeldError', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    await seedLockState(doc, tableName, 'release', staleHeartbeat);
    await new Promise((r) => setTimeout(r, 1_500));
    const service = createMigrationsService(doc, tableName);
    await expect(
      acquireLock(service, baseConfig, {
        mode: 'apply',
        migId: 'mig-new',
        runId: 'r-new-2',
        holder: 'host-new',
      }),
    ).rejects.toMatchObject({ code: 'EDB_MIGRATION_LOCK_HELD' });
  }, 30_000);

  it('TAKEOVER REJECTED: lockState=failed → throws EDBMigrationLockHeldError (operator must unlock)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
    await seedLockState(doc, tableName, 'failed', staleHeartbeat);
    await new Promise((r) => setTimeout(r, 1_500));
    const service = createMigrationsService(doc, tableName);
    await expect(
      acquireLock(service, baseConfig, {
        mode: 'apply',
        migId: 'mig-new',
        runId: 'r-new-3',
        holder: 'host-new',
      }),
    ).rejects.toMatchObject({ code: 'EDB_MIGRATION_LOCK_HELD' });
  }, 30_000);
});
