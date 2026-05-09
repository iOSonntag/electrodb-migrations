/**
 * Phase 6 integration: CTX-08 — rollback refused when a reads-target entity
 * has a later-applied migration.
 *
 * Setup (mirrors Phase 5 rollback integration test pattern — direct _migrations
 * row writes, no actual apply run):
 *   1. Create table + seed Team and User v1 records (setupCtxTestTable).
 *   2. Write a _migrations audit row for M-user (User v1→v2, reads=[Team]) at
 *      status='applied' directly via the service bundle.
 *   3. Write a _migrations audit row for M-team (Team v1→v2) at status='applied'
 *      with fromVersion='2' — making it a CTX-08 blocker.
 *   4. Attempt rollback of M-user via client.rollback().
 *
 * Expected: rejects with EDBRollbackNotPossibleError having
 *   details.reason === 'READS_DEPENDENCY_APPLIED'.
 *
 * The direct-write approach (not running apply first) avoids leaving the lock in
 * 'release' state — which would trigger Case 1 detection. Mirrors the approach
 * used by all Phase 5 rollback integration tests (setupRollbackTestTable with
 * migrationsRowStatus='applied').
 *
 * Migration id hygiene: the blocking M-team id '20260601000010-Team-v2-ctx08'
 * is namespaced so it appears only in this test file.
 *
 * Requirement coverage: CTX-08 (integration level).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import {
  MIGRATIONS_SCHEMA_VERSION,
  createMigrationsService,
} from '../../../src/internal-entities/index.js';
import { EDBRollbackNotPossibleError } from '../../../src/errors/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import {
  createUserReadsTeamMigration,
  createUserV1ReadsTeam,
  createUserV2ReadsTeam,
} from '../../_helpers/sample-migrations/User-reads-Team/index.js';
import { type CtxTestTableSetup, setupCtxTestTable } from '../ctx/_helpers.js';

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
// Migration ids — namespaced to avoid cross-test collisions.
// ---------------------------------------------------------------------------

const USER_READS_TEAM_MIGRATION_ID = '20260601000005-User-reads-Team';
const BLOCKING_TEAM_MIGRATION_ID = '20260601000010-Team-v2-ctx08';

// ---------------------------------------------------------------------------
// Helpers — write audit rows directly (mirrors Phase 5 pattern)
// ---------------------------------------------------------------------------

/**
 * Writes the User migration _migrations row at status='applied' with reads=[Team].
 * Direct write (no actual apply) so the lock stays in 'free' state.
 */
async function writeUserMigrationRow(
  service: ReturnType<typeof createMigrationsService>,
  docClient: Parameters<typeof createUserV1ReadsTeam>[0],
  tableName: string,
): Promise<void> {
  const now = new Date().toISOString();
  const from = createUserV1ReadsTeam(docClient, tableName);
  const to = createUserV2ReadsTeam(docClient, tableName);
  const fromVersion = (from as unknown as { model: { version: string } }).model.version;
  const toVersion = (to as unknown as { model: { version: string } }).model.version;

  await service.migrations
    .put({
      id: USER_READS_TEAM_MIGRATION_ID,
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status: 'applied' as const,
      entityName: 'User',
      fromVersion,
      toVersion,
      fingerprint: '',
      hasDown: true,
      // reads: Set(['Team']) — persisted as a DynamoDB string set.
      // Use a native Set so ElectroDB serializes it correctly via the 'set' schema type.
      reads: new Set(['Team']),
      appliedAt: now,
      appliedRunId: `ctx08-test-user-run-${Date.now()}`,
    } as never)
    .go();
}

/**
 * Writes a synthetic blocking Team _migrations row at status='applied' with
 * fromVersion='2' (>= User migration's toVersion='2' → CTX-08 blocker).
 */
async function writeBlockingTeamMigrationRow(
  service: ReturnType<typeof createMigrationsService>,
): Promise<void> {
  const now = new Date().toISOString();
  await service.migrations
    .put({
      id: BLOCKING_TEAM_MIGRATION_ID,
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status: 'applied' as const,
      entityName: 'Team',
      fromVersion: '2', // >= User migration's toVersion ('2') → CTX-08 blocker
      toVersion: '3',
      fingerprint: '',
      appliedAt: now,
      appliedRunId: `ctx08-test-team-run-${Date.now()}`,
    } as never)
    .go();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CTX-08: rollback refused when reads-target has later applied migration', () => {
  let alive = false;
  let setup: CtxTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 1. Create table + seed Team and User v1 records.
    setup = await setupCtxTestTable({ snapshotMode: 'matching' });

    // 2. Write _migrations rows directly (no apply run; lock stays in 'free' state).
    const service = createMigrationsService(setup.docClient, setup.tableName);
    await writeUserMigrationRow(service, setup.docClient, setup.tableName);
    await writeBlockingTeamMigrationRow(service);
  }, 30_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('refuses with READS_DEPENDENCY_APPLIED reason + correct details fields', async () => {
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

    await expect(
      client.rollback(USER_READS_TEAM_MIGRATION_ID, { strategy: 'projected' }),
    ).rejects.toMatchObject({
      details: {
        reason: 'READS_DEPENDENCY_APPLIED',
        blockingMigration: BLOCKING_TEAM_MIGRATION_ID,
        readsDependency: 'Team',
      },
    });
  }, 30_000);

  it('refusal error is an EDBRollbackNotPossibleError with code EDB_ROLLBACK_NOT_POSSIBLE', async () => {
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

    let caughtError: unknown;
    try {
      await client.rollback(USER_READS_TEAM_MIGRATION_ID, { strategy: 'projected' });
      throw new Error('expected rollback to throw');
    } catch (err) {
      caughtError = err;
    }

    // Duck-type check via code property (per README §9.1 guidance).
    expect((caughtError as { code?: string }).code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
    expect(caughtError).toBeInstanceOf(EDBRollbackNotPossibleError);
  }, 30_000);

  it('refusal includes a remediation pointing at rolling back the blocking migration first', async () => {
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

    let caughtError: unknown;
    try {
      await client.rollback(USER_READS_TEAM_MIGRATION_ID, { strategy: 'projected' });
      throw new Error('expected rollback to throw');
    } catch (err) {
      caughtError = err;
    }

    const remediation = (caughtError as Error & { remediation?: string }).remediation;
    expect(typeof remediation).toBe('string');
    // Remediation must reference the blocking migration id so the operator knows what to do.
    expect(remediation).toContain(`rollback ${BLOCKING_TEAM_MIGRATION_ID}`);
  }, 30_000);
});
