/**
 * RBK-05 + VALIDATION invariants 1, 10 — projected strategy integration tests.
 *
 * Projected strategy (default): calls down(v2) to reconstruct v1 for Type A/B;
 * deletes v1 mirror for Type C. Does NOT delete v2 records.
 *
 * References:
 *   - RBK-05: projected rollback strategy
 *   - VALIDATION invariant 1: scanned === reverted + deleted + skipped + failed
 *   - VALIDATION invariant 10: _migrations.status='reverted' + rollbackStrategy written
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
// Test 1: Case 2 projected with-down
// ---------------------------------------------------------------------------

describe('RBK-05 projected: Case 2 — mixed records; projected does not delete v2', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 3 Type A + 2 Type B + 2 Type C = 7 records total
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 3, bCount: 2, cCount: 2 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('projected Case 2: v1 has 5 records; v2 still has 5; count audit holds; status=reverted; rollbackStrategy=projected', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const result = await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'projected',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Post-rollback v1: 3 A-derived + 2 B-derived = 5 v1 records (type C v1 mirror deleted)
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);

    // v2 still has 5 records (projected does NOT delete v2)
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV2.data.length).toBe(5);

    // VALIDATION invariant 1: scanned === reverted + deleted + skipped + failed
    expect(result.itemCounts.scanned).toBe(result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed);

    // VALIDATION invariant 10: status + rollbackStrategy
    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string; itemCounts: { migrated: number } } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('projected');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: Case 3 projected — finalized migration
// ---------------------------------------------------------------------------

describe('RBK-05 projected: Case 3 — finalized migration; v1 reconstructed from v2', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // Case 3: finalized migration — v1 records are GONE (finalize deleted them).
    // Only v2 remains. Seed 5 v2-only records (no v1).
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { v2Count: 5 },
      migrationsRowStatus: 'finalized',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('projected Case 3: v1 reconstructed from v2 via down(); v2 still present; status=reverted', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const result = await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'projected',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Post-rollback: v1 has 5 records (reconstructed via down())
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);

    // v2 still present (projected does not delete v2)
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV2.data.length).toBe(5);

    expect(result.itemCounts.scanned).toBe(5);
    expect(result.itemCounts.scanned).toBe(result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed);

    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('projected');
  }, 30_000);
});
