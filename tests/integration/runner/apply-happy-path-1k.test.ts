/**
 * RUN-01/02/04 + RUN-09 + B-01 SC1 — 1,000-record apply happy path against DDB Local.
 *
 * Verifies (mapping to ROADMAP Phase 4 Success Criterion #1):
 * (a) v1 records are scanned via ElectroDB identity stamps (RUN-01)
 * (b) v2 records are written via the count-audited batch path (RUN-02)
 * (c) the count audit invariant holds: `scanned == migrated + skipped + failed` exactly (RUN-04)
 * (d) the lock cycle transitions free→apply→release
 * (e) **B-01 SC1: post-apply, ElectroDB v1 query returns 1,000 hits AND v2 query returns 1,000 hits**
 *     (the User-add-status fixture's v2 schema includes a `version` SK-composite component
 *     so v2 rows have a distinct SK byte path — see fixture README.md for rationale)
 * (f) **W-02 RUN-09: the success summary written to stderr contains the literal substring
 *     `Run \`electrodb-migrations release\` after deploying the new code`** (verified via
 *     process.stderr.write spy)
 * (g) the result.applied entry has the right itemCounts
 * (h) `_migrations.itemCounts` row matches the in-memory snapshot
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { setupApplyTestTable, type ApplyTestTableSetup } from './_helpers.js';

// ---------------------------------------------------------------------------
// Test config (fast timeouts for integration; guard cache ~100ms < lock wait ~500ms)
// ---------------------------------------------------------------------------

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: '', // overridden by tableName arg to createMigrationsClient
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('RUN-01/02/04/09 + B-01 SC1: 1,000-record apply happy path', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      setup = await setupApplyTestTable({ recordCount: 1000 });
    }
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      // Run cleanup unguarded: the guard middleware added by createMigrationsClient
      // persists on the shared docClient/raw middleware stack. deleteTestTable uses
      // the raw client which shares the same stack — bypass the guard for teardown.
      await runUnguarded(() => setup.cleanup());
    }
  });

  it('RUN-01/02/04/09 + B-01 SC1: 1,000 v1 records → apply → 1,000 v1 + 1,000 v2 coexist; count audit holds; RUN-09 summary printed', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // W-02 — spy on process.stderr.write BEFORE building the client (apply-summary writes there).
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migrations: [setup.migration],
      });

      // Pre-flight: lock is free; v1 has 1,000 rows; v2 has 0.
      // runUnguarded: after createMigrationsClient is called, the shared docClient
      // middleware stack has the guard attached. We bypass it for test assertions
      // that use the same setup.service / setup.v1Entity / setup.v2Entity clients.
      const beforeLock = await runUnguarded(() => readLockRow(setup.service));
      expect(beforeLock?.lockState).toBe('free');

      const beforeV1 = (await runUnguarded(() => setup.v1Entity.scan.go({ pages: 'all' }))) as { data: Record<string, unknown>[] };
      const beforeV2 = (await runUnguarded(() => setup.v2Entity.scan.go({ pages: 'all' }))) as { data: Record<string, unknown>[] };
      expect(beforeV1.data.length).toBe(1000);
      expect(beforeV2.data.length).toBe(0);

      // Apply.
      const result = await client.apply();

      // Post-conditions — count audit (RUN-04).
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]!.migId).toBe(setup.migration.id);
      const counts = result.applied[0]!.itemCounts;
      expect(counts.scanned).toBe(1000);
      expect(counts.migrated).toBe(1000);
      expect(counts.skipped).toBe(0);
      expect(counts.failed).toBe(0);
      // RUN-04 invariant: scanned == migrated + skipped + failed
      expect(counts.scanned).toBe(counts.migrated + counts.skipped + counts.failed);

      // Lock cycle — after apply the lock should be in release-mode (not free).
      const afterLock = await runUnguarded(() => readLockRow(setup.service));
      expect(afterLock?.lockState).toBe('release');

      // _migrations row reflects the count audit (on-disk audit row matches in-memory).
      const migRow = (await runUnguarded(() => setup.service.migrations.get({ id: setup.migration.id }).go())) as {
        data: { itemCounts?: typeof counts; status: string } | null;
      };
      expect(migRow.data?.status).toBe('applied');
      expect(migRow.data?.itemCounts).toEqual(counts);

      // **B-01 SC1: v1 + v2 records COEXIST** (distinct SK byte paths per fixture README).
      // ElectroDB v1 entity scan returns ONLY v1-owned rows (filters by __edb_e__/__edb_v__).
      const afterV1 = (await runUnguarded(() => setup.v1Entity.scan.go({ pages: 'all' }))) as { data: Record<string, unknown>[] };
      const afterV2 = (await runUnguarded(() => setup.v2Entity.scan.go({ pages: 'all' }))) as { data: Record<string, unknown>[] };
      // ROADMAP SC1: "ElectroDB v1 query returns 1,000 hits AND v2 query returns 1,000"
      expect(afterV1.data.length).toBe(1000); // v1 untouched
      expect(afterV2.data.length).toBe(1000); // v2 freshly written
      expect(afterV2.data.every((r) => r['status'] === 'active')).toBe(true);

      // **W-02 — RUN-09 success summary written to stderr**.
      // Concatenate every stderr.write call's first arg into one string and grep for the literal.
      const stderrText = stderrSpy.mock.calls
        .map((args) =>
          typeof args[0] === 'string'
            ? args[0]
            : Buffer.isBuffer(args[0])
              ? args[0].toString('utf8')
              : '',
        )
        .join('');
      // W-02 load-bearing assertion: the literal substring from renderApplySummary
      expect(stderrText).toContain('Run `electrodb-migrations release` after deploying the new code');
      // Sanity — the count-audit line is also part of the summary (RUN-09 deliverable)
      expect(stderrText).toMatch(/scanned[^\n]*1000/);
    } finally {
      stderrSpy.mockRestore();
    }
  }, 90_000);
});
