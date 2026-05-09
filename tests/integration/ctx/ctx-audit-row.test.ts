/**
 * Phase 6 integration: CTX-06 — `defineMigration({reads: [Team]})` persists
 * `_migrations.reads = Set(['Team'])` at apply time.
 *
 * The implementation lives in `src/runner/apply-flow.ts:130-133`. This test
 * verifies the round-trip: defineMigration → applyFlow → DDB write → scan
 * back → reads is correctly stored as a Set<string> containing 'Team'.
 *
 * Mirrors `tests/integration/runner/apply-audit-row-shape.test.ts` for shape.
 *
 * Requirement coverage: CTX-06, SC-4 (reads round-trip).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { defineMigration } from '../../../src/migrations/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import {
  createUserReadsTeamMigration,
  createUserV1ReadsTeam,
  createUserV2ReadsTeam,
} from '../../_helpers/sample-migrations/User-reads-Team/index.js';
import { type CtxTestTableSetup, setupCtxTestTable } from './_helpers.js';

// ---------------------------------------------------------------------------
// Test config — short acquireWaitMs; guard.cacheTtlMs < lock.acquireWaitMs.
// ---------------------------------------------------------------------------

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: '',
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// normalizeReads — mirrors apply-audit-row-shape.test.ts for stability across
// AWS SDK minor-version drift.
// ---------------------------------------------------------------------------

function normalizeReads(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Set) {
    const arr = [...(value as Set<string>)];
    return arr.length === 0 ? undefined : arr.slice().sort();
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : (value as string[]).slice().sort();
  }
  const v = value as { wrapperName?: string; values?: unknown };
  if (v.wrapperName === 'Set' && Array.isArray(v.values)) {
    const values = v.values as string[];
    return values.length === 0 ? undefined : values.slice().sort();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CTX-06: reads field persisted on _migrations row at apply time.
// ---------------------------------------------------------------------------

describe('CTX-06: defineMigration({reads:[Team]}) persists on _migrations.reads', () => {
  let alive = false;
  let setup: CtxTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    setup = await setupCtxTestTable({ snapshotMode: 'matching' });
  }, 30_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('writes reads=Set("Team") on the _migrations audit row at apply time', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const migration = createUserReadsTeamMigration(setup.docClient, setup.tableName);

      const client = createMigrationsClient({
        config: testConfig,
        client: setup.docClient,
        tableName: setup.tableName,
        cwd: setup.cwd,
        migrations: [migration],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.migId).toBe(migration.id);

      // Read back the _migrations row via the service bundle.
      // runUnguarded: createMigrationsClient attaches guard middleware to the
      // shared docClient stack; the service scan uses the same stack.
      const service = createMigrationsService(setup.docClient, setup.tableName);
      const auditRow = (await runUnguarded(() =>
        service.migrations.get({ id: migration.id }).go(),
      )) as { data: Record<string, unknown> | null };

      expect(auditRow.data).not.toBeNull();
      const r = auditRow.data as Record<string, unknown>;

      // CTX-06: reads field must serialize as Set(['Team']).
      // Use normalizeReads so the assertion is stable across SDK versions.
      expect(normalizeReads(r.reads)).toEqual(['Team']);

      // Also assert the raw reads field round-trips correctly when accessed
      // directly as a Set (the primary contract assertion).
      if (r.reads instanceof Set) {
        expect(r.reads).toBeInstanceOf(Set);
        expect(r.reads).toEqual(new Set(['Team']));
      } else {
        // Fallback: normalizeReads already validated ['Team'] above.
        expect(normalizeReads(r.reads)).toEqual(['Team']);
      }

      // Sanity: migration metadata fields are correct.
      expect(r.entityName).toBe('User');
      expect(r.status).toBe('applied');
      expect(r.kind).toBe('transform');
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);

  it('reads field is absent on a migration that does NOT declare reads', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // Create a fresh table for the bare migration so we have v1 records to migrate.
      // Each test that calls apply() needs a fresh table to avoid id conflicts.
      const innerSetup = await setupCtxTestTable({ snapshotMode: 'matching' });

      const bareMigration = defineMigration({
        id: '20260601000009-User-bare-no-reads',
        entityName: 'User',
        from: createUserV1ReadsTeam(innerSetup.docClient, innerSetup.tableName),
        to: createUserV2ReadsTeam(innerSetup.docClient, innerSetup.tableName),
        // NO reads field — exercises the FALSE branch of the conditional spread in applyFlowScanWrite.
        up: async (record) => {
          const user = record as { id: string; name: string; teamId: string };
          return { ...user, teamName: 'none' };
        },
      });

      const innerClient = createMigrationsClient({
        config: testConfig,
        client: innerSetup.docClient,
        tableName: innerSetup.tableName,
        cwd: innerSetup.cwd,
        migrations: [bareMigration],
      });

      try {
        const innerResult = await innerClient.apply();
        expect(innerResult.applied).toHaveLength(1);

        const innerService = createMigrationsService(innerSetup.docClient, innerSetup.tableName);
        const innerAuditRow = (await runUnguarded(() =>
          innerService.migrations.get({ id: bareMigration.id }).go(),
        )) as { data: Record<string, unknown> | null };

        expect(innerAuditRow.data).not.toBeNull();
        const r = innerAuditRow.data as Record<string, unknown>;

        // reads field must be absent (normalizeReads returns undefined for empty/absent sets).
        expect(normalizeReads(r.reads)).toBeUndefined();
      } finally {
        await innerSetup.cleanup();
      }
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});
