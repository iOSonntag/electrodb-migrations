/**
 * RUN-05 — multi-migration continuous lock cycle against DDB Local.
 *
 * Two pending migrations applied in one `apply` invocation:
 * - User-add-status  (v1→v2, adds `status='active'`)
 * - User-add-tier    (v2→v3, adds `tier='free'`)
 *
 * Verifies:
 * - `result.applied.length === 2` (both migrations applied in one call)
 * - Lock is in `release` mode with BOTH migration ids in `releaseIds`
 *   (proves the lock was held continuously across the boundary)
 * - Both `_migrations` rows are `status='applied'`
 * - v3 entity scan returns 100 records with `status='active'` and `tier='free'`
 *
 * The lock cycle: apply→release (mig-1) → append/transitionReleaseToApply →
 * apply→release (mig-2) — all within a single `client.apply()` call.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import { createUserAddTierMigration, createUserV3 } from '../../_helpers/sample-migrations/User-add-tier/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { setupApplyTestTable, type ApplyTestTableSetup } from './_helpers.js';

// ---------------------------------------------------------------------------
// Test config (fast timeouts for integration)
// ---------------------------------------------------------------------------

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: '', // overridden by tableName arg to createMigrationsClient
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('RUN-05: multi-migration continuous lock cycle (apply-batch)', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      // Seed 100 records — smaller than 1k test; this test focuses on lock cycle, not throughput.
      setup = await setupApplyTestTable({ recordCount: 100 });
    }
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      // runUnguarded: guard middleware on shared docClient persists after client.apply();
      // bypass is required for the DeleteTable control-plane call used by cleanup.
      await runUnguarded(() => setup.cleanup());
    }
  });

  it('RUN-05: applies two pending migrations back-to-back; lock continuously held; releaseIds contains BOTH', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Suppress RUN-09 summary to stderr (not the focus of this test).
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // Build the User-add-tier migration bound to the test table.
      const migrationTier = createUserAddTierMigration(setup.doc, setup.tableName);
      const v3Entity = createUserV3(setup.doc, setup.tableName);

      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        // Pass both migrations in order: User-add-status (v1→v2) then User-add-tier (v2→v3).
        // resolvePending() sorts by (entityName, fromVersion) so order matches numeric sequence.
        migrations: [setup.migration, migrationTier],
      });

      // Apply both migrations in one call (RUN-05 — continuous lock cycle).
      const result = await client.apply();

      // Both migrations applied.
      expect(result.applied).toHaveLength(2);
      expect(result.applied[0]!.migId).toBe(setup.migration.id);
      expect(result.applied[1]!.migId).toBe(migrationTier.id);

      // Lock is in release with BOTH releaseIds present (proves continuous gating).
      const lock = await runUnguarded(() => readLockRow(setup.service));
      expect(lock?.lockState).toBe('release');
      // releaseIds should contain both migration ids.
      const releaseIds = lock?.releaseIds ?? new Set<string>();
      const releaseIdSet = new Set(typeof releaseIds[Symbol.iterator] === 'function' ? [...(releaseIds as Iterable<string>)] : []);
      expect(releaseIdSet.has(setup.migration.id)).toBe(true);
      expect(releaseIdSet.has(migrationTier.id)).toBe(true);

      // Both _migrations rows are 'applied'.
      const all = (await runUnguarded(() => setup.service.migrations.scan.go({ pages: 'all' }))) as { data: Array<{ id: string; status: string }> };
      expect(all.data.find((r) => r.id === setup.migration.id)?.status).toBe('applied');
      expect(all.data.find((r) => r.id === migrationTier.id)?.status).toBe('applied');

      // v3 entity scan returns 100 records with both `status` AND `tier` populated.
      const v3Scan = (await runUnguarded(() => v3Entity.scan.go({ pages: 'all' }))) as { data: Record<string, unknown>[] };
      expect(v3Scan.data).toHaveLength(100);
      expect(v3Scan.data.every((r) => r['status'] === 'active' && r['tier'] === 'free')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  }, 90_000);
});
