/**
 * RUN-08 — apply failure leaves migration `failed` with partial v2 writes intact.
 *
 * Verifies:
 *   (a) `up()` throws on a specific record (synthetic failure via `createUserAddStatusMigration_failOn`).
 *   (b) Records BEFORE the throwing one MAY be written to v2 (page-flush-dependent — see test note).
 *   (c) `_migration_state.lockState='failed'` after the throw.
 *   (d) `_migrations.status='failed'` (or lock.failedIds contains the migration id).
 *   (e) Calling `apply` again is refused (lock is held in 'failed', not in takeover allowlist).
 *
 * Fixture: User-add-status (B-01) with 50 seeded v1 records.
 * The failing record id is 'u-000010' (10th record in the default seed factory).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import { createUserAddStatusMigration_failOn } from '../../_helpers/sample-migrations/User-add-status/migration.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { type ApplyTestTableSetup, setupApplyTestTable } from './_helpers.js';

/** Fast config for integration tests — short acquireWaitMs so tests run quickly. */
const testConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: undefined,
  tableName: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as const;

describe('RUN-08: apply fail-fast — up() throw → lock=failed → re-apply refused', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeEach(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      setup = await setupApplyTestTable({ recordCount: 50 });
    }
  }, 40_000);

  afterEach(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('RUN-08: apply throws on record 10; lock=failed; re-apply refused', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const failingMigration = createUserAddStatusMigration_failOn(setup.doc, setup.tableName, 'u-000010');
    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [failingMigration],
    });

    // Run apply; expect throw.
    await expect(client.apply()).rejects.toThrow();

    // Lock is in 'failed' state.
    const lock = await readLockRow(setup.service);
    expect(lock?.lockState).toBe('failed');

    // _migrations row is `failed` OR lock's failedIds contains the migration id.
    const migRow = (await setup.service.migrations.get({ id: failingMigration.id }).go()) as { data: { status: string } | null };
    if (migRow.data) {
      expect(migRow.data.status).toBe('failed');
    } else {
      expect([...(lock?.failedIds ?? [])]).toContain(failingMigration.id);
    }

    // Partial v2 writes: with the default pageSize=100 and 50 seeded records,
    // ALL records read in one page; up() runs record-by-record before any
    // batch flush. So when up('u-000010') throws, NO batch has flushed yet
    // → expected zero v2 writes within the failing page. If the runner
    // implementation changes to flush per-record, update this assertion.
    const v2Scan = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: Record<string, unknown>[] };
    expect(v2Scan.data.length).toBe(0); // no partial writes within the failing page

    // Re-apply attempt: the failed migration is NOT in the pending list
    // (status='failed' excludes it from `resolvePendingMigrations`) so `apply`
    // returns `{ applied: [] }` without acquiring the lock. The lock REMAINS in
    // 'failed' state — proving the runner did not attempt to take over the failed lock.
    // (Operator must run `rollback` to recover, which WILL attempt lock acquisition
    // and fail with EDBMigrationLockHeldError if called concurrently).
    const reApplyResult = await client.apply();
    expect(reApplyResult.applied).toEqual([]);
    // Lock is still 'failed' — the second apply skipped lock acquisition entirely.
    const lockAfterReApply = await readLockRow(setup.service);
    expect(lockAfterReApply?.lockState).toBe('failed');
  }, 60_000);
});
