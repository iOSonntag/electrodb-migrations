/**
 * Bootstrap helper for Phase 6 cross-entity reads integration tests.
 *
 * Creates a DDB Local table, seeds Team and User v1 records, writes a Team
 * snapshot file into a temp directory matching (or mismatching) the imported
 * Team entity's fingerprint, and returns a bundle suitable for end-to-end
 * ctx tests.
 *
 * Mirrors `tests/integration/rollback/_helpers.ts::setupRollbackTestTable`
 * for shape and conventions.
 *
 * Usage:
 *   const setup = await setupCtxTestTable({ snapshotMode: 'matching' });
 *   // ... run apply against setup.tableName, setup.docClient ...
 *   await setup.cleanup();
 *
 * Reference: Plan 06-06 (Phase 6 Wave 5 integration bootstrap infrastructure).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fingerprintEntityModel } from '../../../src/safety/index.js';
import { entitySnapshotPath, writeEntitySnapshot, FRAMEWORK_SNAPSHOT_VERSION } from '../../../src/snapshot/index.js';
import { createTeamEntityReadsTeam, createUserV1ReadsTeam, createUserV2ReadsTeam } from '../../_helpers/sample-migrations/User-reads-Team/index.js';
import {
  bootstrapMigrationState,
  createTestTable,
  deleteTestTable,
  makeDdbLocalClient,
  randomTableName,
} from '../_helpers/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Controls the Team snapshot file written to `cwd`:
 *   - 'matching':   fingerprint matches Team entity's fingerprint (in-bounds case).
 *   - 'mismatched': fingerprint is 'wrong-fingerprint-for-test' (out-of-bounds case;
 *     simulates a Team migration applied after the User migration was authored).
 *   - 'absent':     no snapshot file is written.
 */
export type SnapshotMode = 'matching' | 'mismatched' | 'absent';

/**
 * The object returned by `setupCtxTestTable`.
 *
 * Provides everything a Phase 6 ctx integration test needs: the DDB clients,
 * the temporary snapshot directory (as `cwd`), seed counts, and a `cleanup()`
 * closure that tears down the ephemeral table and temp directory.
 */
export interface CtxTestTableSetup {
  /** The ephemeral DDB Local table name (unique per test run). */
  tableName: string;
  /** Document client (for `createMigrationsClient` and entity use). */
  docClient: DynamoDBDocumentClient;
  /** Raw DynamoDB client (for low-level assertions). */
  ddbClient: DynamoDBClient;
  /**
   * The temp dir housing `.electrodb-migrations/snapshots/`.
   * Pass as `cwd` to `createMigrationsClient` so the runner resolves snapshot paths
   * against the test's own temp dir rather than `process.cwd()`.
   */
  cwd: string;
  /** Number of Team records seeded. */
  teamCount: number;
  /** Tear down the ephemeral table and temp dir (call in `afterAll`). */
  cleanup: () => Promise<void>;
}

/**
 * Arguments for `setupCtxTestTable`.
 */
export interface SetupCtxTestTableArgs {
  /**
   * Controls the Team snapshot file written to `cwd`.
   * See {@link SnapshotMode} for details.
   */
  snapshotMode: SnapshotMode;
  /** Number of Team records to seed (default 5). */
  teamCount?: number;
  /** Number of User v1 records to seed (default 5). */
  userCount?: number;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Set up an ephemeral DDB Local table for a Phase 6 ctx integration test.
 *
 * Steps performed (in order):
 *   1. Allocate a temp dir for snapshots (mkdtempSync).
 *   2. Allocate a unique DDB Local table name and create DDB clients.
 *   3. `createTestTable` — provision the table and wait for ACTIVE status.
 *   4. `bootstrapMigrationState` — write the initial `_migration_state` row.
 *   5. Seed `teamCount` Team records (id: team-N, teamLabel: `Team-N`).
 *   6. Seed `userCount` User v1 records (id: user-N, name: `User-N`,
 *      teamId: `team-${N % teamCount}`).
 *   7. Write Team snapshot per `args.snapshotMode`.
 *   8. Write User snapshot (always matching — User is the migration's own entity
 *      and needs a snapshot for future validate gate; Phase 6 ctx only validates
 *      reads targets, but having it written avoids Pitfall 3 surprises later).
 *   9. Return setup bundle including a `cleanup` closure.
 *
 * @param args - See {@link SetupCtxTestTableArgs}.
 * @returns A fully-initialized {@link CtxTestTableSetup}.
 */
export async function setupCtxTestTable(args: SetupCtxTestTableArgs): Promise<CtxTestTableSetup> {
  const { snapshotMode, teamCount: teamCountArg = 5, userCount: userCountArg = 5 } = args;

  // Step 1: create temp dir for snapshots.
  const cwd = mkdtempSync(join(tmpdir(), 'ctx-test-'));

  // Step 2: create DDB Local clients.
  const { raw: ddbClient, doc: docClient } = makeDdbLocalClient();

  // Step 3: create unique table name and provision table.
  const tableName = randomTableName('ctx-test');
  await createTestTable(ddbClient, tableName);

  // Step 4: bootstrap migration state row.
  await bootstrapMigrationState(docClient, tableName);

  // Step 5: seed Team records.
  const teamEntity = createTeamEntityReadsTeam(docClient, tableName);
  for (let i = 0; i < teamCountArg; i++) {
    await teamEntity.put({ id: `team-${i}`, teamLabel: `Team-${i}` }).go();
  }

  // Step 6: seed User v1 records (each with a teamId pointing at a seeded team).
  const userV1Entity = createUserV1ReadsTeam(docClient, tableName);
  for (let i = 0; i < userCountArg; i++) {
    await userV1Entity
      .put({ id: `user-${i}`, name: `User-${i}`, teamId: `team-${i % teamCountArg}` })
      .go();
  }

  // Step 7: write Team snapshot per snapshotMode.
  const teamSnapshotPath = entitySnapshotPath(cwd, 'Team');
  if (snapshotMode !== 'absent') {
    const { fingerprint: realFingerprint, projection: teamProjection } = fingerprintEntityModel(
      (teamEntity as unknown as { model: unknown }).model,
    );

    const fingerprint =
      snapshotMode === 'matching' ? realFingerprint : 'wrong-fingerprint-for-test';

    writeEntitySnapshot(teamSnapshotPath, {
      schemaVersion: FRAMEWORK_SNAPSHOT_VERSION,
      fingerprint,
      // biome-ignore lint/suspicious/noExplicitAny: EntityProjection is not directly assignable to Record<string,unknown>; safe cast at snapshot boundary.
      projection: teamProjection as unknown as Record<string, unknown>,
    });
  }

  // Step 8: write User snapshot (always matching — guards against Pitfall 3 for
  // future validate tests; Phase 6 ctx only reads snapshots for declared reads targets).
  const userV2Entity = createUserV2ReadsTeam(docClient, tableName);
  const { fingerprint: userFingerprint, projection: userProjection } = fingerprintEntityModel(
    (userV2Entity as unknown as { model: unknown }).model,
  );
  writeEntitySnapshot(entitySnapshotPath(cwd, 'User'), {
    schemaVersion: FRAMEWORK_SNAPSHOT_VERSION,
    fingerprint: userFingerprint,
    // biome-ignore lint/suspicious/noExplicitAny: EntityProjection is not directly assignable to Record<string,unknown>; safe cast at snapshot boundary.
    projection: userProjection as unknown as Record<string, unknown>,
  });

  const cleanup = async (): Promise<void> => {
    await deleteTestTable(ddbClient, tableName);
    rmSync(cwd, { recursive: true, force: true });
  };

  return {
    tableName,
    docClient,
    ddbClient,
    cwd,
    teamCount: teamCountArg,
    cleanup,
  };
}
