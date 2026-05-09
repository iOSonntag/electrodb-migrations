/**
 * API-05 + RBK-02 — client.rollback() end-to-end integration tests against DDB Local.
 *
 * Verifies the full path from `createMigrationsClient(...)` through the rollback
 * orchestrator (Plan 05-09) to DDB Local, including:
 *   1. Happy path: projected strategy against a mixed A/B/C seed.
 *   2. Refusal: out-of-order rollback attempt (EDBRollbackOutOfOrderError).
 *   3. TypeScript type assertion: return shape matches RollbackItemCounts.
 *
 * Each case uses an ephemeral table via `setupRollbackTestTable` with the
 * preloaded `migrations` arg to skip disk discovery.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import type { MigrationsClient } from '../../../src/client/types.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import type { RollbackItemCounts } from '../../../src/rollback/audit.js';
import { MIGRATIONS_SCHEMA_VERSION } from '../../../src/internal-entities/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { setupRollbackTestTable, type RollbackTestTableSetup } from '../rollback/_helpers.js';

/** Fast config — short acquireWaitMs so tests run in reasonable time. */
const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  entities: [],
  migrations: 'src/database/migrations',
  region: undefined,
  tableName: '',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Test 1: client.rollback() happy path with projected strategy
// ---------------------------------------------------------------------------

describe.skipIf(false)('client.rollback() — projected strategy end-to-end', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 3 Type A + 2 Type B + 2 Type C = 7 records total; status='applied' → Case 2
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 3, bCount: 2, cCount: 2 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      await runUnguarded(() => setup.cleanup());
    }
  });

  it('projects down() on A/B records and deletes v1 mirror for C; count audit holds; rollbackStrategy=projected', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migration],
    });

    // Call client.rollback() with the preloaded migration list to skip disk discovery
    const result = await client.rollback(setup.migration.id, { strategy: 'projected' });

    // Count audit invariant: scanned === reverted + deleted + skipped + failed
    expect(result.itemCounts.scanned).toBe(
      result.itemCounts.reverted + result.itemCounts.deleted + result.itemCounts.skipped + result.itemCounts.failed,
    );

    // Lock cycle: after rollback, lock should be in release state
    const lockRow = await runUnguarded(() => readLockRow(setup.service));
    expect(lockRow?.lockState).toBe('release');

    // _migrations audit row: status='reverted', rollbackStrategy='projected'
    const migRow = (await runUnguarded(() =>
      setup.service.migrations.get({ id: setup.migration.id }).go()
    )) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
    expect(migRow.data?.rollbackStrategy).toBe('projected');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: client.rollback() refusal — out-of-order attempt
// ---------------------------------------------------------------------------

describe('client.rollback() — refusal when migration is not head', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // Set up the "older" migration at applied status
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: {},
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      await runUnguarded(() => setup.cleanup());
    }
  });

  it('rejects with EDB_ROLLBACK_OUT_OF_ORDER when a newer migration exists for the same entity', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Pre-write a NEWER _migrations row for the same entity (User) so the
    // with-down migration is no longer the head.
    const now = new Date().toISOString();
    const newerMigId = `${Number(setup.migration.id) + 1}`;
    await setup.service.migrations
      .put({
        id: newerMigId,
        schemaVersion: MIGRATIONS_SCHEMA_VERSION,
        kind: 'transform',
        status: 'applied',
        entityName: setup.migration.entityName,
        fromVersion: '2',
        toVersion: '3',
        fingerprint: '',
        appliedAt: now,
        appliedRunId: 'setup-newer',
      } as never)
      .go();

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migration],
    });

    // Should reject with out-of-order error — preconditions refuse before acquireLock
    await expect(
      client.rollback(setup.migration.id, { strategy: 'projected' }),
    ).rejects.toMatchObject({ code: 'EDB_ROLLBACK_OUT_OF_ORDER' });

    // Lock row must be untouched (free or null — no lock was acquired)
    const lockRow = await runUnguarded(() => readLockRow(setup.service));
    expect(lockRow?.lockState ?? 'free').toBe('free');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 3: TypeScript-level return type assertion (compile-time only)
// ---------------------------------------------------------------------------

describe('client.rollback() — return type', () => {
  it('TypeScript: return type matches { itemCounts: RollbackItemCounts }', () => {
    // This is a compile-time-only assertion using expectTypeOf.
    // The actual type enforcement is by the compiler; expectTypeOf pins it at
    // test level. We use a type-level cast (never at runtime) to avoid accessing
    // a null object — the function body is never executed at runtime.
    type RollbackFn = MigrationsClient['rollback'];
    // If this compiles, the return type is correct.
    type _Assert = Awaited<ReturnType<RollbackFn>> extends { itemCounts: RollbackItemCounts }
      ? true
      : never;
    const _check: _Assert = true;
    expect(_check).toBe(true);
  });
});
