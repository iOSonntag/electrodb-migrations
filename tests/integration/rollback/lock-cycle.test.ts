/**
 * RBK-02 + VALIDATION invariant 4 — lock-cycle integration tests.
 *
 * Proves that the rollback orchestrator drives the correct lock state transitions:
 *   - Success path: free → rollback → release
 *   - Failure path: free → rollback → failed
 *
 * References:
 *   - RBK-02: lock state transitions for rollback
 *   - VALIDATION invariant 4: lock transitions are atomic and observable
 *   - Plan 05-01 OQ9 widening: acquireLock(mode='rollback') permits entry from {free,release,failed}
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLockRow } from '../../../src/lock/index.js';
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
// Test 1: success → free → rollback → release
// ---------------------------------------------------------------------------

describe('RBK-02 lock-cycle: success — free → rollback → release', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 2, bCount: 1, cCount: 1 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('lock transitions: free (pre) → release (post) + _migrations.status=reverted', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Pre-condition: lock is free
    const preLock = await readLockRow(setup.service);
    expect(preLock?.lockState).toBe('free');

    await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'projected',
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Post-condition: lock is release
    const postLock = await readLockRow(setup.service);
    expect(postLock?.lockState).toBe('release');

    // _migrations row shows reverted
    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as { data: { status: string } | null };
    expect(migRow.data?.status).toBe('reverted');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: failure → free → rollback → failed
// ---------------------------------------------------------------------------

describe('RBK-02 lock-cycle: failure — free → rollback → failed', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 2, bCount: 1, cCount: 0 } },
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('lock transitions: free (pre) → failed (post) when strategy throws', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Pre-condition: lock is free
    const preLock = await readLockRow(setup.service);
    expect(preLock?.lockState).toBe('free');

    // Build a failing custom strategy by injecting a resolver that throws.
    // Use a migration variant with rollbackResolver that throws on the first call.
    let callCount = 0;
    const failingMigration = {
      ...setup.migration,
      rollbackResolver: async () => {
        callCount++;
        if (callCount >= 1) throw new Error('resolver-failed-intentionally');
        return null;
      },
    } as typeof setup.migration;

    await expect(
      rollback({
        service: setup.service,
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migration: failingMigration,
        strategy: 'custom',
        runId: randomUUID(),
        holder: 'test-host:1234',
      }),
    ).rejects.toThrow('resolver-failed-intentionally');

    // Post-condition: lock is in 'failed' state
    const postLock = await readLockRow(setup.service);
    expect(postLock?.lockState).toBe('failed');
  }, 30_000);
});
