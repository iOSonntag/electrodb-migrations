/**
 * B-03 — guarded GETs during finalize ALL succeed.
 *
 * Decision A7 (per `.planning/phases/03-internal-entities-lock-guard/03-WAVE0-NOTES.md`):
 * `'finalize'` is INTENTIONALLY EXCLUDED from GATING_LOCK_STATES. This means
 * guarded clients (app traffic) MUST NOT throw `EDBMigrationInProgressError` when
 * the lock is in `'finalize'` state. This test proves that invariant end-to-end
 * against DynamoDB Local, with 20 concurrent guarded GETs fired while finalize runs.
 *
 * Strategy:
 *   1. Apply + release (so we have 100 v1 + 100 v2 rows for a non-trivially-long finalize).
 *   2. Spawn `client.finalize(id)` as a Promise.
 *   3. Fire 20 guarded GETs against v2 rows (v2 ids are known from the apply step).
 *   4. Assert: (a) finalize resolves; (b) every GET succeeds; (c) lockState='finalize' WAS observed.
 *
 * The lockState observation in step (c) prevents the test from being vacuous — if finalize
 * completes before any GET fires, the test would pass trivially. Asserting that we DID see
 * 'finalize' in the observations confirms the concurrency actually occurred.
 *
 * ROADMAP Phase 4 Success Criterion #4: "finalize <id> deletes all v1 records under
 * maintenance-mode lock, app traffic unaffected via guarded read."
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMigrationInProgress } from '../../../src/index.js';
import { createMigrationsClient } from '../../../src/client/index.js';
import { readLockRow } from '../../../src/lock/index.js';
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

describe('B-03: guarded GETs during finalize succeed (Decision A7: finalize NOT in GATING_LOCK_STATES)', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeEach(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      // 100 records give finalize enough work (~1-2s) so concurrent GETs can race it.
      setup = await setupApplyTestTable({ recordCount: 100 });
    }
  }, 40_000);

  afterEach(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('B-03: guarded GETs during finalize ALL succeed (finalize NOT in GATING_LOCK_STATES — Decision A7)', async () => {
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

    // Apply + release first so we're in a clean post-bake state with v1 + v2 rows.
    await client.apply();
    await client.release();
    expect((await readLockRow(setup.service))?.lockState).toBe('free');

    // Pre-finalize sanity: v2 has 100 rows.
    const v2Before = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: Array<{ id: string }> };
    expect(v2Before.data.length).toBe(100);
    // Save the v2 ids — guarded GETs will read these by id.
    const v2Ids = v2Before.data.map((r) => r.id);

    // Get the guarded client and build a v2 entity bound to it.
    const guarded = client.guardedClient();
    // Build a v2 entity bound to the guarded client using setup.v2EntityFactory.
    // This ensures GETs go through the guard middleware.

    type GetFailure = { ok: false; isInProgress: boolean; code: string; lockState: string };
    type Outcome = { ok: true } | GetFailure;
    const fireGuardedGet = async (id: string): Promise<Outcome> => {
      try {
        const v2GuardedEntity = setup.v2EntityFactory(guarded, setup.tableName);
        // v2 SK composite includes `version` (default='v2') — must supply it for the get key.
        await v2GuardedEntity.get({ id, version: 'v2' } as never).go();
        return { ok: true };
      } catch (err) {
        const e = err as { code?: unknown; details?: { lockState?: unknown } };
        return {
          ok: false,
          isInProgress: isMigrationInProgress(err),
          code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
          lockState: typeof e.details?.lockState === 'string' ? e.details.lockState : '',
        };
      }
    };

    // Track lockState observations across the run (pre-finalize, mid, post).
    const lockStateObservations: string[] = [];
    const observeLockState = async () => {
      const row = await readLockRow(setup.service);
      if (row?.lockState) lockStateObservations.push(row.lockState);
    };

    // Spawn finalize.
    const finalizePromise = client.finalize(setup.migration.id);

    // Concurrent guarded-GET storm: 20 GETs spaced ~50ms apart.
    const gets: Promise<Outcome>[] = [];
    for (let i = 0; i < 20; i++) {
      const targetId = v2Ids[i % v2Ids.length]!;
      gets.push(
        (async () => {
          await new Promise((r) => setTimeout(r, i * 50));
          // Sample lock state mid-run too — interleave with GETs.
          if (i % 4 === 0) await observeLockState();
          return fireGuardedGet(targetId);
        })(),
      );
    }

    const [finResult, ...getResults] = await Promise.all([finalizePromise, ...gets]);

    // (a) finalize succeeded.
    expect(finResult.finalized).toHaveLength(1);

    // (b) EVERY guarded GET succeeded.
    const failures = getResults.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    const successes = getResults.filter((o) => o.ok);
    expect(successes).toHaveLength(20);
    expect(failures).toHaveLength(0);

    // (c) The lockState observations MUST include 'finalize'. This proves the test
    // was non-vacuous — we actually observed the maintenance-mode state during the run.
    // If this assertion fails, increase recordCount or decrease the observation interval.
    expect(lockStateObservations).toContain('finalize');
  }, 120_000);
});
