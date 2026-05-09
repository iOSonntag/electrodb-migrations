/**
 * RBK-08 + VALIDATION invariant 7 — custom strategy integration tests.
 *
 * Custom strategy: dispatches each record to the user-supplied rollbackResolver.
 * Works for both Case 2 and Case 3 (unlike snapshot/fill-only).
 *
 * References:
 *   - RBK-08: custom rollback strategy
 *   - VALIDATION invariant 7: resolver result validation (Pitfall 3)
 *   - User-add-status-with-resolver fixture
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
// Test 1: Case 2 custom with-resolver
// ---------------------------------------------------------------------------

describe('RBK-08 custom: Case 2 — with-resolver fixture; rollbackResolver dispatched', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-resolver',
      seed: { mixed: { aCount: 3, bCount: 2, cCount: 0 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('custom Case 2: resolver called for each record; v1 reconstructed; rollbackStrategy=custom', async () => {
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
      strategy: 'custom',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Post-rollback v1: 3 A (existing + possibly re-written) + 2 B (filled via resolver)
    // Type A: resolver returns v1Original → put v1 (reverted++)
    // Type B: resolver returns down(v2) → put v1 (reverted++)
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);

    // v2 still has 5 records (custom does NOT delete v2 unless resolver returns null for A/C)
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV2.data.length).toBe(5);

    // Count audit invariant
    expect(result.itemCounts.scanned).toBe(result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed);

    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('custom');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: Case 3 custom with-resolver
// ---------------------------------------------------------------------------

describe('RBK-08 custom: Case 3 — finalized migration; resolver dispatched for all type B', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // Case 3: finalized — v1 gone; only v2 present (all type B from classifier's perspective)
    setup = await setupRollbackTestTable({
      fixture: 'with-resolver',
      seed: { v2Count: 5 },
      migrationsRowStatus: 'finalized',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('custom Case 3: resolver reconstructs v1 from v2 (type B); rollbackStrategy=custom', async () => {
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
      strategy: 'custom',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // After rollback: v1 reconstructed from down(v2) via resolver
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);

    expect(result.itemCounts.scanned).toBe(5);
    expect(result.itemCounts.scanned).toBe(result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed);

    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('custom');
  }, 30_000);
});
