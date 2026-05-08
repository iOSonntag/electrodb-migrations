/**
 * REL-01/02 — release clears the release-mode lock; second consecutive release
 * is a friendly idempotent no-op; release on apply-state lock rejects with
 * EDB_RELEASE_PREMATURE.
 *
 * Tests:
 *   REL-01: release after apply clears the release-mode lock (cleared=true).
 *   REL-02 (a): release on a free lock (no active release-mode) — friendly no-op.
 *   REL-02 (b): two consecutive release calls — first cleared, second no-op.
 *   REL-02 (c): release while lock is in 'apply' state rejects EDB_RELEASE_PREMATURE.
 *
 * Note: the EXHAUSTIVE Plan 11 unit-level coverage of the OTHER 4 non-release
 * lockStates (finalize, rollback, failed, dying) is NOT replicated here — this
 * integration test is a narrower smoke-test focused on the apply-state path that
 * is most likely to occur in operator usage. Plan 11 CMC-7d..h covers the other
 * states at unit level.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { acquireLock, readLockRow } from '../../../src/lock/index.js';
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

describe('REL-01/02: release clears lock; idempotent no-op; EDB_RELEASE_PREMATURE on apply-state', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeEach(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      // 10 records — small table; this test is about lock state, not throughput.
      setup = await setupApplyTestTable({ recordCount: 10 });
    }
  }, 40_000);

  afterEach(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('REL-01: release clears release-mode lock', async () => {
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
    await client.apply(); // lock is now in release-mode

    const r = await client.release();
    expect(r.cleared).toBe(true);

    const lock = await readLockRow(setup.service);
    expect(lock?.lockState).toBe('free');
  }, 30_000);

  it('REL-02: release on free lock is friendly no-op', async () => {
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
    // Lock starts free (just bootstrap).
    const r = await client.release();
    expect(r.cleared).toBe(false);
    expect(r.reason).toBe('no-active-release-lock');
  }, 30_000);

  it('REL-02: two consecutive `release` calls — first cleared, second no-op', async () => {
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
    await client.apply();
    const r1 = await client.release();
    expect(r1.cleared).toBe(true);
    const r2 = await client.release();
    expect(r2.cleared).toBe(false);
    expect(r2.reason).toBe('no-active-release-lock');
  }, 30_000);

  it('REL-02: release while lock is in `apply` rejects with EDB_RELEASE_PREMATURE', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Manually acquire a lock in apply mode (using state-mutations directly, bypassing the runner).
    await acquireLock(setup.service, testConfig, { mode: 'apply', migId: 'manual', runId: 'r-test', holder: 'h' });
    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migration],
    });
    await expect(client.release()).rejects.toMatchObject({ code: 'EDB_RELEASE_PREMATURE' });
  }, 30_000);
});
