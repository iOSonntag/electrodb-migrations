/**
 * Phase 6 integration: CTX-02 + CTX-05 four-cell matrix (SC-5).
 *
 * Covers the four combinations of declared/undeclared × in-bounds/out-of-bounds
 * cross-entity reads. Together these prove the full Phase 6 safety invariant:
 * stale reads are caught eagerly (declared) or lazily (undeclared) BEFORE any
 * v2 write hits DynamoDB.
 *
 * Cells:
 *   1. declared + in-bounds:      reads:[Team], snapshot matches → apply succeeds; v2 records written.
 *   2. declared + out-of-bounds:  reads:[Team], snapshot mismatch → EDBStaleEntityReadError BEFORE any v2 write.
 *   3. undeclared + in-bounds:    reads:[], ctx.entity(Team) at runtime; snapshot matches → succeeds; v2 written.
 *   4. undeclared + out-of-bounds: reads:[], snapshot mismatch → EDBStaleEntityReadError at first ctx.entity(Team) call.
 *
 * Requirement coverage: CTX-02, CTX-04, CTX-05 (integration level).
 * SC-5: All four cells pass against DDB Local.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { defineMigration } from '../../../src/migrations/index.js';
import { EDBStaleEntityReadError } from '../../../src/errors/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import {
  createTeamEntityReadsTeam,
  createUserReadsTeamMigration,
  createUserV1ReadsTeam,
  createUserV2ReadsTeam,
} from '../../_helpers/sample-migrations/User-reads-Team/index.js';
import { type CtxTestTableSetup, setupCtxTestTable } from './_helpers.js';

// ---------------------------------------------------------------------------
// Shared test config — short acquireWaitMs so tests complete quickly.
// guard.cacheTtlMs < lock.acquireWaitMs satisfies the load-bearing invariant.
// ---------------------------------------------------------------------------

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: '', // overridden per test via createMigrationsClient tableName arg
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// Inline undeclared-reads migration factory (Cells 3 + 4).
//
// Same User v1→v2 + Team logic as the User-reads-Team fixture but with NO
// `reads` field — this is what makes it an "undeclared" cross-entity read.
// The ctx cast follows the Migration.up signature (`ctx?: unknown`) and uses
// `as` casts to call ctx.entity() without `// @ts-expect-error`.
// ---------------------------------------------------------------------------

const createUndeclaredReadsMigration = (client: Parameters<typeof createUserV1ReadsTeam>[0], table: string) =>
  defineMigration({
    id: '20260601000007-User-reads-Team-undeclared',
    entityName: 'User',
    from: createUserV1ReadsTeam(client, table),
    to: createUserV2ReadsTeam(client, table),
    // NO reads field — this is what makes Cells 3 and 4 "undeclared".
    up: async (record, ctx) => {
      const user = record as { id: string; name: string; teamId: string };
      // Cast matches the fixture pattern (migration.ts line 47). ctx is `unknown`
      // until the Phase 6 type-tightening pass; the `as` cast is load-bearing here.
      const ctxApi = ctx as
        | {
            entity: (
              e: unknown,
            ) => { get: (k: object) => { go: () => Promise<{ data: unknown }> } };
          }
        | undefined;
      let teamName = 'unknown';
      if (ctxApi !== undefined) {
        const teamRes = await ctxApi
          .entity(createTeamEntityReadsTeam(client, table))
          .get({ id: user.teamId })
          .go();
        teamName = (teamRes?.data as { teamLabel?: string })?.teamLabel ?? 'unknown';
      }
      return { ...user, teamName };
    },
    down: async (record) => {
      const { teamName: _t, version: _v, ...v1 } = record as Record<string, unknown>;
      return v1;
    },
  });

// ---------------------------------------------------------------------------
// Cell 1: declared + in-bounds
// reads:[Team], Team snapshot fingerprint matches → apply succeeds, v2 records written.
// ---------------------------------------------------------------------------

describe('Cell 1: declared + in-bounds — reads:[Team], snapshot matches', () => {
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

  it('declared + in-bounds: apply succeeds; v2 records carry teamName from Team entity', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Suppress RUN-09 stderr output — not the focus of this test.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const client = createMigrationsClient({
        config: testConfig,
        client: setup.docClient,
        tableName: setup.tableName,
        cwd: setup.cwd,
        migrations: [createUserReadsTeamMigration(setup.docClient, setup.tableName)],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);

      // Verify v2 records exist and carry teamName.
      const v2Entity = createUserV2ReadsTeam(setup.docClient, setup.tableName);
      const v2Scan = (await runUnguarded(() =>
        v2Entity.scan.go({ pages: 'all' }),
      )) as { data: Array<{ id: string; teamName?: string }> };

      expect(v2Scan.data.length).toBeGreaterThan(0);
      // Every v2 record must have a non-empty teamName (denormalized from Team).
      const allHaveTeamName = v2Scan.data.every(
        (r) => typeof r.teamName === 'string' && r.teamName !== 'unknown',
      );
      expect(allHaveTeamName).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cell 2: declared + out-of-bounds
// reads:[Team], Team snapshot fingerprint mismatch → EDBStaleEntityReadError BEFORE v2 writes.
// ---------------------------------------------------------------------------

describe('Cell 2: declared + out-of-bounds — reads:[Team], snapshot mismatched', () => {
  let alive = false;
  let setup: CtxTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    setup = await setupCtxTestTable({ snapshotMode: 'mismatched' });
  }, 30_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('declared + out-of-bounds: apply throws EDBStaleEntityReadError BEFORE any v2 record is written', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.docClient,
      tableName: setup.tableName,
      cwd: setup.cwd,
      migrations: [createUserReadsTeamMigration(setup.docClient, setup.tableName)],
    });

    await expect(client.apply()).rejects.toThrow(EDBStaleEntityReadError);

    // T-06-06-04 load-bearing safety assertion: NO v2 record was written.
    // The eager pre-flight must throw before any v2 put() is issued.
    const v2Entity = createUserV2ReadsTeam(setup.docClient, setup.tableName);
    const v2Scan = (await runUnguarded(() =>
      v2Entity.scan.go({ pages: 'all' }),
    )) as { data: unknown[] };
    expect(v2Scan.data.length).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cell 3: undeclared + in-bounds
// reads:[], ctx.entity(Team) at runtime; snapshot matches → lazy validation passes; v2 written.
// ---------------------------------------------------------------------------

describe('Cell 3: undeclared + in-bounds — no reads, snapshot matches', () => {
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

  it('undeclared + in-bounds: lazy validation passes; apply succeeds; v2 records carry teamName', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const client = createMigrationsClient({
        config: testConfig,
        client: setup.docClient,
        tableName: setup.tableName,
        cwd: setup.cwd,
        migrations: [createUndeclaredReadsMigration(setup.docClient, setup.tableName)],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);

      const v2Entity = createUserV2ReadsTeam(setup.docClient, setup.tableName);
      const v2Scan = (await runUnguarded(() =>
        v2Entity.scan.go({ pages: 'all' }),
      )) as { data: Array<{ id: string; teamName?: string }> };

      expect(v2Scan.data.length).toBeGreaterThan(0);
      // Every v2 record must have teamName populated via the undeclared ctx read.
      const allHaveTeamName = v2Scan.data.every(
        (r) => typeof r.teamName === 'string' && r.teamName !== 'unknown',
      );
      expect(allHaveTeamName).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Cell 4: undeclared + out-of-bounds
// reads:[], snapshot mismatched → ctx.entity(Team) throws EDBStaleEntityReadError at first call.
// ---------------------------------------------------------------------------

describe('Cell 4: undeclared + out-of-bounds — no reads, snapshot mismatched', () => {
  let alive = false;
  let setup: CtxTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    setup = await setupCtxTestTable({ snapshotMode: 'mismatched' });
  }, 30_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('undeclared + out-of-bounds: ctx.entity(Team) throws EDBStaleEntityReadError at first call', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.docClient,
      tableName: setup.tableName,
      cwd: setup.cwd,
      migrations: [createUndeclaredReadsMigration(setup.docClient, setup.tableName)],
    });

    await expect(client.apply()).rejects.toThrow(EDBStaleEntityReadError);

    // No v2 records should have been written before the lazy validation error.
    const v2Entity = createUserV2ReadsTeam(setup.docClient, setup.tableName);
    const v2Scan = (await runUnguarded(() =>
      v2Entity.scan.go({ pages: 'all' }),
    )) as { data: unknown[] };
    expect(v2Scan.data.length).toBe(0);
  }, 60_000);
});
