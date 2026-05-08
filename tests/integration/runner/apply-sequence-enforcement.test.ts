/**
 * RUN-06/07 — apply --migration <wrong-id> rejects with EDB_NOT_NEXT_PENDING;
 * zero-pending exits clean.
 *
 * Tests:
 *   RUN-06 (a): apply --migration <future-id> rejects naming actual next id;
 *               lock stays free (sequence check is pre-lock — no acquireLock attempted).
 *   RUN-06 (b): apply --migration <unknown-id> rejects with EDB_NOT_PENDING.
 *   RUN-07:     apply against zero pending (all marked 'applied') exits cleanly
 *               with empty applied array.
 *
 * Setup: TWO migrations on disk (User-add-status v1→v2, User-add-tier v2→v3).
 * Zero records seeded — the sequence rejection happens before any DDB scan.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import { MIGRATIONS_SCHEMA_VERSION } from '../../../src/internal-entities/index.js';
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

describe('RUN-06/07: sequence enforcement + zero-pending fast path', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeEach(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      // Zero records — sequence check is pre-scan.
      setup = await setupApplyTestTable({ recordCount: 0 });
    }
  }, 40_000);

  afterEach(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('RUN-06: apply --migration <future-id> rejects naming actual next id; lock stays free', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migrationStatus, setup.migrationTier],
    });

    let caught: (Error & { code?: string; remediation?: string }) | undefined;
    try {
      await client.apply({ migrationId: setup.migrationTier.id });
    } catch (err) {
      caught = err as Error & { code?: string; remediation?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe('EDB_NOT_NEXT_PENDING');
    expect(caught!.remediation).toContain(setup.migrationStatus.id);
    expect(caught!.remediation).toContain('v1→v2');

    // Lock is still free — no acquireLock attempted (sequence check is pre-lock).
    const lock = await readLockRow(setup.service);
    expect(lock?.lockState).toBe('free');
  }, 30_000);

  it('RUN-06: apply --migration <unknown-id> rejects with EDB_NOT_PENDING', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migrationStatus, setup.migrationTier],
    });
    await expect(client.apply({ migrationId: 'not-a-real-id' })).rejects.toMatchObject({ code: 'EDB_NOT_PENDING' });
  }, 30_000);

  it('RUN-07: apply against zero pending exits cleanly with empty applied', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Pre-write _migrations rows for both fixtures with status='applied' so they're not pending.
    await setup.service.migrations
      .put({
        id: setup.migrationStatus.id,
        schemaVersion: MIGRATIONS_SCHEMA_VERSION,
        kind: 'transform',
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
        status: 'applied',
        appliedAt: new Date().toISOString(),
        fingerprint: 'fp-status',
      } as never)
      .go();
    await setup.service.migrations
      .put({
        id: setup.migrationTier.id,
        schemaVersion: MIGRATIONS_SCHEMA_VERSION,
        kind: 'transform',
        entityName: 'User',
        fromVersion: '2',
        toVersion: '3',
        status: 'applied',
        appliedAt: new Date().toISOString(),
        fingerprint: 'fp-tier',
      } as never)
      .go();

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migrationStatus, setup.migrationTier],
    });
    const result = await client.apply();
    expect(result.applied).toEqual([]);
  }, 30_000);
});
