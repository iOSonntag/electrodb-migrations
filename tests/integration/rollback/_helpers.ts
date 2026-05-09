/**
 * Bootstrap helper for Phase 5 rollback integration tests.
 *
 * Mirrors `tests/integration/runner/_helpers.ts` (`setupApplyTestTable`) but
 * provides rollback-specific setup: fixture variant selection, mixed-record
 * seeding (A/B/C cells), and pre-writing the `_migrations` audit row at a
 * specific lifecycle status so rollback tests can target a specific case
 * (Case 1 / Case 2 / Case 3) without running the full apply path.
 *
 * Usage pattern (mirrors Phase 4 helper):
 *
 * ```typescript
 * let setup: RollbackTestTableSetup;
 * beforeAll(async () => {
 *   setup = await setupRollbackTestTable({
 *     fixture: 'with-down',
 *     seed: { v1Count: 5, v2Count: 5 },
 *     migrationsRowStatus: 'applied',
 *   });
 * }, 30_000);
 * afterAll(async () => {
 *   await setup.cleanup();
 * });
 * ```
 *
 * Reference: Plan 05-01 (Phase 5 Wave 0 integration bootstrap infrastructure).
 * Analogous to `tests/integration/runner/_helpers.ts` from Phase 4.
 */

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  MIGRATIONS_SCHEMA_VERSION,
  createMigrationsService,
  type MigrationsServiceBundle,
} from '../../../src/internal-entities/index.js';
import type { Migration } from '../../../src/migrations/types.js';
import type { AnyElectroEntity } from '../../../src/migrations/types.js';
import { createUserAddStatusNoDownMigration } from '../../_helpers/sample-migrations/User-add-status-no-down/index.js';
import { createUserV1 as createUserV1NoDown, createUserV2 as createUserV2NoDown } from '../../_helpers/sample-migrations/User-add-status-no-down/index.js';
import { createUserAddStatusWithDownMigration } from '../../_helpers/sample-migrations/User-add-status-with-down/index.js';
import { createUserV1 as createUserV1WithDown, createUserV2 as createUserV2WithDown } from '../../_helpers/sample-migrations/User-add-status-with-down/index.js';
import { createUserAddStatusWithResolverMigration } from '../../_helpers/sample-migrations/User-add-status-with-resolver/index.js';
import { createUserV1 as createUserV1WithResolver, createUserV2 as createUserV2WithResolver } from '../../_helpers/sample-migrations/User-add-status-with-resolver/index.js';
import { createTeamEntity, createUserAddStatusStdMigration } from '../../_helpers/sample-migrations/User-and-Team-std/index.js';
import { createUserV1Std, createUserV2Std } from '../../_helpers/sample-migrations/User-and-Team-std/index.js';
import {
  bootstrapMigrationState,
  createTestTable,
  deleteTestTable,
  makeDdbLocalClient,
  randomTableName,
  seedV1Records,
} from '../_helpers/index.js';
import { seedMixedRecords, seedV2Records } from '../_helpers/index.js';

/** Alias for the return type of `createMigrationsService`. */
type MigrationsService = MigrationsServiceBundle;

/**
 * The object returned by `setupRollbackTestTable`.
 *
 * Provides everything a rollback integration test needs: the migrations service
 * bundle, the bound v1/v2 entities, the composed migration fixture (for the
 * requested fixture variant), and a `cleanup()` closure that tears down the
 * ephemeral table.
 */
export interface RollbackTestTableSetup {
  /** Migrations service bundle (migrationState, migrations, migrationRuns + transaction). */
  service: MigrationsService;
  /** The ephemeral DDB Local table name (unique per test run). */
  tableName: string;
  /** Raw DynamoDB client (for low-level assertions). */
  raw: DynamoDBClient;
  /** Document client (for higher-level assertions and entity use). */
  doc: DynamoDBDocumentClient;
  /** Bound UserV1 entity pointing at `tableName`. */
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity return types carry heavy generics.
  v1Entity: any;
  /** Bound UserV2 entity pointing at `tableName`. */
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity return types carry heavy generics.
  v2Entity: any;
  /**
   * For `'std'` fixture only: bound Team entity pointing at `tableName`.
   * Undefined for other fixture variants.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity return types carry heavy generics.
  teamEntity?: any;
  /** The migration instance for the requested fixture variant. */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** Tear down the ephemeral table (call in `afterAll`). */
  cleanup: () => Promise<void>;
}

/**
 * Pre-write status options for the `_migrations` audit row.
 * Controls which lifecycle case the rollback test targets without running apply.
 */
export type MigrationsRowStatus = 'applied' | 'finalized' | 'failed' | 'pending';

/**
 * Arguments for `setupRollbackTestTable`.
 */
export interface SetupRollbackTestTableArgs {
  /**
   * Which fixture variant to instantiate.
   * - `'with-down'`: has `down()` — canonical projected/fill-only/custom happy-path.
   * - `'with-resolver'`: has both `down()` and `rollbackResolver` — custom strategy.
   * - `'no-down'`: up-only, no `down` or `rollbackResolver` — for refusal tests.
   * - `'std'`: User + Team co-located — for RBK-11 STD safety tests.
   *
   * Default: `'with-down'`.
   */
  fixture?: 'with-down' | 'with-resolver' | 'no-down' | 'std';
  /**
   * Pre-seed counts. Each property is optional and defaults to 0.
   * - `v1Count`: seed N v1-shaped records via `seedV1Records`.
   * - `v2Count`: seed N v2-shaped records via `seedV2Records`.
   * - `mixed`: seed a mixed A/B/C cell population via `seedMixedRecords`.
   *
   * If both `v1Count`/`v2Count` and `mixed` are supplied, all seeds are applied
   * in order: v1Count → v2Count → mixed.
   */
  seed?: {
    v1Count?: number;
    v2Count?: number;
    mixed?: { aCount: number; bCount: number; cCount: number };
  };
  /**
   * Pre-write the `_migrations` audit row for this migration with this status.
   * Skips the actual apply path so rollback tests can target a specific lifecycle
   * case (Case 1 / Case 2 / Case 3) without running apply first.
   *
   * - `'applied'` (default): sets `status='applied'`, populates `appliedAt` and
   *   `appliedRunId`. This is Case 2 — the most common rollback scenario.
   * - `'finalized'`: sets `status='finalized'`, populates `appliedAt`, `appliedRunId`,
   *   AND `finalizedAt`. This is Case 3.
   * - `'failed'`: sets `status='failed'`. No applied/finalized timestamps.
   * - `'pending'`: sets `status='pending'`. Minimal row (no applied timestamps).
   *
   * If omitted, no `_migrations` row is written — the table is in pre-apply state.
   */
  migrationsRowStatus?: MigrationsRowStatus;
  /**
   * Override the auto-generated table name (optional).
   */
  tableName?: string;
}

/**
 * Set up an ephemeral DDB Local table for a Phase 5 rollback integration test.
 *
 * Steps performed (in order):
 *   1. Allocate a uniquely-named table via `randomTableName('rollback-test')`.
 *   2. `createTestTable` — provision the table and wait for ACTIVE status.
 *   3. `bootstrapMigrationState` — write the initial `_migration_state` row.
 *   4. Seed records based on `args.seed` (v1Count → v2Count → mixed, in that order).
 *   5. If `args.migrationsRowStatus` is supplied, write a `_migrations` audit row
 *      at the requested status so rollback tests start from the right lifecycle case.
 *   6. Return the setup bundle including a `cleanup` closure.
 *
 * @param args - See {@link SetupRollbackTestTableArgs}.
 * @returns A fully-initialized {@link RollbackTestTableSetup}.
 */
export async function setupRollbackTestTable(
  args: SetupRollbackTestTableArgs = {},
): Promise<RollbackTestTableSetup> {
  const { fixture = 'with-down', seed = {}, migrationsRowStatus, tableName: suppliedName } = args;

  const tableName = suppliedName ?? randomTableName('rollback-test');
  const { raw, doc } = makeDdbLocalClient();

  await createTestTable(raw, tableName);
  await bootstrapMigrationState(doc, tableName);

  // Build entity + migration instances for the requested fixture.
  let v1Entity: ReturnType<typeof createUserV1WithDown>;
  let v2Entity: ReturnType<typeof createUserV2WithDown>;
  // biome-ignore lint/suspicious/noExplicitAny: Team entity only present for 'std' fixture.
  let teamEntity: any | undefined;
  let migration: Migration<AnyElectroEntity, AnyElectroEntity>;

  switch (fixture) {
    case 'with-down':
      v1Entity = createUserV1WithDown(doc, tableName);
      v2Entity = createUserV2WithDown(doc, tableName);
      migration = createUserAddStatusWithDownMigration(doc, tableName) as Migration<AnyElectroEntity, AnyElectroEntity>;
      break;
    case 'with-resolver':
      v1Entity = createUserV1WithResolver(doc, tableName) as ReturnType<typeof createUserV1WithDown>;
      v2Entity = createUserV2WithResolver(doc, tableName) as ReturnType<typeof createUserV2WithDown>;
      migration = createUserAddStatusWithResolverMigration(doc, tableName) as Migration<AnyElectroEntity, AnyElectroEntity>;
      break;
    case 'no-down':
      v1Entity = createUserV1NoDown(doc, tableName) as ReturnType<typeof createUserV1WithDown>;
      v2Entity = createUserV2NoDown(doc, tableName) as ReturnType<typeof createUserV2WithDown>;
      migration = createUserAddStatusNoDownMigration(doc, tableName) as Migration<AnyElectroEntity, AnyElectroEntity>;
      break;
    case 'std':
      v1Entity = createUserV1Std(doc, tableName) as ReturnType<typeof createUserV1WithDown>;
      v2Entity = createUserV2Std(doc, tableName) as ReturnType<typeof createUserV2WithDown>;
      teamEntity = createTeamEntity(doc, tableName);
      migration = createUserAddStatusStdMigration(doc, tableName) as Migration<AnyElectroEntity, AnyElectroEntity>;
      break;
    default: {
      const exhaustive: never = fixture;
      throw new Error(`Unknown fixture variant: ${String(exhaustive)}`);
    }
  }

  const service = createMigrationsService(doc, tableName);

  // Seed records based on requested counts.
  if ((seed.v1Count ?? 0) > 0) {
    await seedV1Records(v1Entity, seed.v1Count!);
  }
  if ((seed.v2Count ?? 0) > 0) {
    await seedV2Records(v2Entity, seed.v2Count!);
  }
  if (seed.mixed) {
    await seedMixedRecords({
      v1Entity,
      v2Entity,
      aCount: seed.mixed.aCount,
      bCount: seed.mixed.bCount,
      cCount: seed.mixed.cCount,
    });
  }

  // Pre-write the _migrations audit row if requested.
  if (migrationsRowStatus !== undefined) {
    const now = new Date().toISOString();
    const syntheticRunId = `setup-run-${Date.now()}`;

    const fromVersion = (migration.from as unknown as { model: { version: string } }).model.version;
    const toVersion = (migration.to as unknown as { model: { version: string } }).model.version;

    const baseRow = {
      id: migration.id,
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status: migrationsRowStatus,
      entityName: migration.entityName,
      fromVersion,
      toVersion,
      fingerprint: '', // Phase 7 validate gate writes the real sha256 fingerprint
      ...(migration.down !== undefined ? { hasDown: true } : {}),
      ...(migration.rollbackResolver !== undefined ? { hasRollbackResolver: true } : {}),
    };

    const statusFields: Record<string, unknown> = {};
    if (migrationsRowStatus === 'applied' || migrationsRowStatus === 'finalized') {
      statusFields.appliedAt = now;
      statusFields.appliedRunId = syntheticRunId;
    }
    if (migrationsRowStatus === 'finalized') {
      statusFields.finalizedAt = now;
    }

    await service.migrations.put({ ...baseRow, ...statusFields } as never).go();
  }

  const cleanup = async (): Promise<void> => {
    await deleteTestTable(raw, tableName);
  };

  return {
    service,
    tableName,
    raw,
    doc,
    v1Entity,
    v2Entity,
    ...(teamEntity !== undefined ? { teamEntity } : {}),
    migration,
    cleanup,
  };
}
