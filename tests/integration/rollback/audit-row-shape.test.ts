/**
 * Pitfall 9 + VALIDATION invariant 10 — audit-row shape integration test.
 *
 * Pins every field on the `_migrations` audit row post-rollback, specifically:
 *   - rollbackStrategy is always written (Pitfall 9)
 *   - status === 'reverted'
 *   - revertedAt is a recent ISO timestamp
 *   - itemCounts shape including the WARNING 1 mapping (audit.reverted → migrated)
 *   - appliedAt and appliedRunId are preserved (not cleared on rollback)
 *
 * References:
 *   - Pitfall 9: rollbackStrategy ALWAYS written
 *   - WARNING 1: audit.reverted → itemCounts.migrated
 *   - VALIDATION invariant 10: status='reverted' + rollbackStrategy populated
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rollback } from '../../../src/rollback/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { type RollbackTestTableSetup, setupRollbackTestTable } from './_helpers.js';

/** Fast config — short acquireWaitMs so tests run quickly. */
const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  entities: [],
  migrations: '',
  region: undefined,
  tableName: '',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Audit-row shape — one successful rollback; exhaustive field assertions
// ---------------------------------------------------------------------------

describe('Pitfall 9 + WARNING 1 — _migrations audit-row shape post-rollback', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;
  let preAppliedAt: string | undefined;
  let preAppliedRunId: string | undefined;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 3 pure Type A records (v1+v2 both present) → projected puts v1 for each
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 3, bCount: 0, cCount: 0 } },
      migrationsRowStatus: 'applied',
    });

    // Capture the pre-rollback appliedAt/appliedRunId so we can verify they are preserved.
    const preRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { appliedAt?: string; appliedRunId?: string } | null;
    };
    preAppliedAt = preRow.data?.appliedAt;
    preAppliedRunId = preRow.data?.appliedRunId;
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('exhaustive _migrations field assertions post-rollback (projected, 3 records)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const runId = randomUUID();
    const beforeRollback = Date.now();

    await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'projected',
      runId,
      holder: 'test-host:1234',
    });

    const row = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: Record<string, unknown> | null;
    };

    expect(row.data).not.toBeNull();
    const r = row.data as Record<string, unknown>;

    // Core identity fields
    expect(r.id).toBe(setup.migration.id);
    expect(r.entityName).toBe('User');

    // Status and timestamps
    expect(r.status).toBe('reverted');
    expect(typeof r.revertedAt).toBe('string');
    const revertedAt = new Date(r.revertedAt as string).getTime();
    expect(revertedAt).toBeGreaterThanOrEqual(beforeRollback);
    expect(r.revertedRunId).toBe(runId);

    // Version fields
    expect(r.fromVersion).toBe('1');
    expect(r.toVersion).toBe('2');

    // Pitfall 9: rollbackStrategy ALWAYS written
    expect(r.rollbackStrategy).toBe('projected');

    // WARNING 1: audit.reverted → itemCounts.migrated
    // 3 Type A records → projected calls down(v2) for each → puts v1 → 3 reverted
    // In transitionToReleaseMode: itemCounts.migrated = audit.reverted = 3
    const itemCounts = r.itemCounts as { scanned: number; migrated: number; deleted: number; skipped: number; failed: number } | undefined;
    expect(itemCounts).toBeDefined();
    expect(itemCounts?.scanned).toBe(3);
    expect(itemCounts?.migrated).toBe(3); // WARNING 1: mapped from audit.reverted
    expect(itemCounts?.deleted).toBe(0); // no type C
    expect(itemCounts?.skipped).toBe(0);
    expect(itemCounts?.failed).toBe(0);

    // appliedAt and appliedRunId are preserved (NOT cleared on rollback)
    if (preAppliedAt !== undefined) {
      expect(r.appliedAt).toBe(preAppliedAt);
    }
    if (preAppliedRunId !== undefined) {
      expect(r.appliedRunId).toBe(preAppliedRunId);
    }

    // Fixture-derived fields
    expect(r.hasDown).toBe(true); // with-down fixture has down()
    expect(r.hasRollbackResolver).toBeUndefined(); // with-down does not have rollbackResolver
  }, 30_000);
});
