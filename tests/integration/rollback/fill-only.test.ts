/**
 * RBK-07 — fill-only strategy integration tests.
 *
 * Fill-only strategy: only fills in Type B records via down(v2);
 * Type A and Type C are kept as-is. Does NOT delete v2 records.
 *
 * References:
 *   - RBK-07: fill-only rollback strategy
 *   - RESEARCH §Section 4 lines 1200-1207
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
// Test 1: Case 2 fill-only with-down
// ---------------------------------------------------------------------------

describe('RBK-07 fill-only: Case 2 — only type B filled; A and C kept; v2 unchanged', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 3 A + 2 B + 2 C = 7 records total
    // fill-only: A → skip (v1 already exists), B → down(v2) → put v1, C → skip
    // Post-rollback v1: 3+2+2 = 7 (3A existing + 2B new fills + 2C existing)
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 3, bCount: 2, cCount: 2 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('fill-only Case 2: v1=7 (A+B filled+C); v2=5 (unchanged); rollbackStrategy=fill-only', async () => {
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
      strategy: 'fill-only',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Post-rollback v1: 3 (A, already existed) + 2 (B, filled via down) + 2 (C, already existed) = 7
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(7);

    // v2 still has 5 records (fill-only does NOT delete v2)
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV2.data.length).toBe(5);

    // Count audit invariant
    expect(result.itemCounts.scanned).toBe(result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed);

    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('fill-only');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: Case 3 fill-only refusal — FINALIZED_ONLY_PROJECTED
// ---------------------------------------------------------------------------

describe('RBK-07 fill-only: Case 3 refusal — FINALIZED_ONLY_PROJECTED', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { v2Count: 3 },
      migrationsRowStatus: 'finalized',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('Case 3 fill-only refusal: throws EDBRollbackNotPossibleError with FINALIZED_ONLY_PROJECTED', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    await expect(
      rollback({
        service: setup.service,
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migration: setup.migration,
        strategy: 'fill-only',
        runId: randomUUID(),
        holder: 'test-host:1234',
      }),
    ).rejects.toMatchObject({ details: { reason: 'FINALIZED_ONLY_PROJECTED' } });
  }, 30_000);
});
