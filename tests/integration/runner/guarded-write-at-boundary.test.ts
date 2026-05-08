/**
 * B-02 — guarded write at multi-migration boundary throws EDBMigrationInProgressError.
 *
 * **Purpose:** ROADMAP Phase 4 Success Criterion #2 says "app traffic stays gated
 * continuously per the guarded-client check across the multi-migration boundary."
 * This test provides the regression-proof end-to-end assertion.
 *
 * **Decision A7 (03-WAVE0-NOTES.md):** `'release'` IS in `GATING_LOCK_STATES`.
 * This means a guarded write fired AFTER the last migration completes (when the lock
 * is in `release` awaiting the operator's `release` call) MUST be blocked.
 *
 * **Strategy:** Two phases of guarded writes:
 *
 * Phase A — concurrent writes during apply (16 writes spaced 75ms apart):
 *   These fire while the lock cycles through `apply` → `release` → `apply` → `release`.
 *   Most will observe `'apply'` state. Some may observe `'release'` at the boundary.
 *
 * Phase B — post-apply writes (4 writes after apply resolves):
 *   After `client.apply()` resolves, the lock is in `release` state waiting for the
 *   operator's `release` call. The guard cache TTL (100ms) ensures fresh reads observe
 *   the actual state. These writes WILL observe `'release'` and must throw.
 *
 * **Load-bearing assertions:**
 * (b) ALL 20 guarded writes threw `EDBMigrationInProgressError`
 * (c) Every error has `isInProgress=true` and `code='EDB_MIGRATION_IN_PROGRESS'`
 * (d) `lockState='apply'` was observed (from Phase A)
 * (d) `lockState='release'` was observed (from Phase B, guaranteed by apply completing)
 *     — THIS is the B-02 / Decision A7 assertion
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { isMigrationInProgress } from '../../../src/errors/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { createUserAddTierMigration } from '../../_helpers/sample-migrations/User-add-tier/index.js';
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
  tableName: '', // overridden by tableName arg
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Outcome type
// ---------------------------------------------------------------------------

type Outcome =
  | { ok: true }
  | { ok: false; code?: string; lockState?: string; isInProgress: boolean };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('B-02 — guarded write at multi-migration boundary (Decision A7: release IS in GATING_LOCK_STATES)', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      // 50 records per migration — enough to keep the runner busy for ~300-500ms per migration.
      setup = await setupApplyTestTable({ recordCount: 50 });
    }
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      await runUnguarded(() => setup.cleanup());
    }
  });

  it('B-02: guarded writes throughout multi-migration apply ALL throw EDBMigrationInProgressError; release-mode IS in GATING_LOCK_STATES (Decision A7)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Suppress RUN-09 summary to stderr (not the focus of this test).
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const migrationTier = createUserAddTierMigration(setup.doc, setup.tableName);

      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migrations: [setup.migration, migrationTier],
      });

      const guarded = client.guardedClient();

      // Helper: fire a guarded PutCommand that does NOT collide with runner's writes.
      // Distinct PK prefix (`app#guarded-write#<i>`) the runner never touches.
      const fireGuardedWrite = async (i: number): Promise<Outcome> => {
        try {
          await guarded.send(
            new PutCommand({
              TableName: setup.tableName,
              Item: {
                pk: `app#guarded-write#${i}`,
                sk: `app#guarded-write#${i}`,
                payload: 'app-traffic',
              },
            }),
          );
          return { ok: true };
        } catch (err) {
          const e = err as { code?: string; details?: { lockState?: string } };
          const out: Outcome = {
            ok: false,
            isInProgress: isMigrationInProgress(err),
          };
          if (e.code !== undefined) out.code = e.code;
          if (e.details?.lockState !== undefined) out.lockState = e.details.lockState;
          return out;
        }
      };

      // ---------------------------------------------------------------------------
      // Phase A — concurrent writes during the apply run.
      // ---------------------------------------------------------------------------

      // Start the apply (not awaited yet).
      const applyPromise = client.apply();

      // 16 writes spaced 75ms apart = 1.2s window during the apply run.
      // The apply run with acquireWaitMs=500 + 50 records × 2 migrations takes ~1.5-2s.
      // Most of these will observe 'apply' state; a few may catch the release boundary.
      const phaseAWrites: Promise<Outcome>[] = [];
      for (let i = 0; i < 16; i++) {
        phaseAWrites.push(
          (async (): Promise<Outcome> => {
            await new Promise<void>((r) => setTimeout(r, i * 75));
            return fireGuardedWrite(i);
          })(),
        );
      }

      // Wait for the apply to complete.
      const applyResult = await applyPromise;

      // ---------------------------------------------------------------------------
      // Phase B — post-apply writes (lock is in 'release' state).
      // ---------------------------------------------------------------------------
      // After apply() resolves, the lock is stable in 'release'. The guard cache
      // TTL (100ms) means the first post-apply write after a 110ms pause will
      // force a fresh DDB read and observe 'release'. Fire 4 writes with a brief
      // initial delay to ensure the guard cache TTL has expired.
      const phaseBWrites: Promise<Outcome>[] = [];
      for (let i = 0; i < 4; i++) {
        phaseBWrites.push(
          (async (): Promise<Outcome> => {
            // 150ms delay: 100ms (cache TTL) + 50ms buffer ensures a fresh read.
            await new Promise<void>((r) => setTimeout(r, 150 + i * 50));
            return fireGuardedWrite(16 + i);
          })(),
        );
      }

      // Collect all Phase A + Phase B outcomes.
      const phaseAResults = await Promise.all(phaseAWrites);
      const phaseBResults = await Promise.all(phaseBWrites);
      const allOutcomes: Outcome[] = [...phaseAResults, ...phaseBResults];

      // ---------------------------------------------------------------------------
      // Assertions
      // ---------------------------------------------------------------------------

      // (a) apply succeeded.
      expect(applyResult.applied).toHaveLength(2);

      // (b) EVERY guarded write threw (zero successes).
      const successes = allOutcomes.filter((o) => o.ok);
      const failures = allOutcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
      expect(successes).toHaveLength(0); // no write succeeded
      expect(failures).toHaveLength(20); // all 20 failed

      // (c) Every failure satisfies isMigrationInProgress + EDB_MIGRATION_IN_PROGRESS.
      for (const f of failures) {
        expect(f.isInProgress).toBe(true);
        expect(f.code).toBe('EDB_MIGRATION_IN_PROGRESS');
      }

      // (d) lockState values include AT LEAST one 'apply' (from Phase A)
      //     AND one 'release' (from Phase B — the B-02 load-bearing assertion).
      const lockStatesSeen = new Set(
        failures
          .map((f) => f.lockState)
          .filter((s): s is string => typeof s === 'string'),
      );
      // Phase A: at least one write should have observed 'apply' state.
      expect(lockStatesSeen.has('apply')).toBe(true);
      // **B-02 load-bearing assertion — Decision A7 end-to-end:**
      // Phase B writes fired after apply() resolved when lock is stable in 'release'.
      // These MUST be blocked. 'release' IS in GATING_LOCK_STATES.
      expect(lockStatesSeen.has('release')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  }, 120_000);
});
