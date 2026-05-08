/**
 * Bootstrap helper for Phase 4 runner integration tests.
 *
 * Composes `createTestTable` + `bootstrapMigrationState` + `seedV1Records` into
 * a single setup call so every runner integration test gets a fully-initialized
 * ephemeral DDB Local table with a known number of seeded v1 User records and a
 * freshly bootstrapped `_migration_state` row.
 *
 * Usage pattern (mirrors `tests/integration/lock/multi-migration-batch.test.ts`
 * lines 36-51):
 *
 * ```typescript
 * let setup: ApplyTestTableSetup;
 * beforeAll(async () => {
 *   setup = await setupApplyTestTable({ recordCount: 10 });
 * }, 30_000);
 * afterAll(async () => {
 *   await setup.cleanup();
 * });
 * ```
 */

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { createUserAddStatusMigration } from '../../_helpers/sample-migrations/User-add-status/index.js';
import { createUserV1 } from '../../_helpers/sample-migrations/User-add-status/v1.js';
import { createUserV2 } from '../../_helpers/sample-migrations/User-add-status/v2.js';
import {
  bootstrapMigrationState,
  createTestTable,
  deleteTestTable,
  makeDdbLocalClient,
  randomTableName,
} from '../_helpers/index.js';
import { seedV1Records } from '../_helpers/seed-records.js';

/** Alias for the return type of `createMigrationsService`. */
type MigrationsService = ReturnType<typeof createMigrationsService>;

/**
 * The object returned by `setupApplyTestTable`.
 *
 * Provides everything a runner integration test needs: the migrations service
 * bundle, the bound v1/v2 entities, the composed migration fixture, and a
 * `cleanup()` closure that tears down the ephemeral table.
 */
export interface ApplyTestTableSetup {
  /** Migrations service bundle (migrationState, migrations, migrationRuns + transaction). */
  service: MigrationsService;
  /** The ephemeral DDB Local table name (unique per test run). */
  tableName: string;
  /** Raw DynamoDB client (for low-level assertions). */
  raw: DynamoDBClient;
  /** Document client (for higher-level assertions and entity use). */
  doc: DynamoDBDocumentClient;
  /** Bound UserV1 entity pointing at `tableName`. */
  v1Entity: ReturnType<typeof createUserV1>;
  /** Bound UserV2 entity pointing at `tableName`. */
  v2Entity: ReturnType<typeof createUserV2>;
  /** Bound User v1→v2 migration pointing at `tableName`. */
  migration: ReturnType<typeof createUserAddStatusMigration>;
  /** Tear down the ephemeral table (call in `afterAll`). */
  cleanup: () => Promise<void>;
}

/**
 * Set up an ephemeral DDB Local table for a Phase 4 runner integration test.
 *
 * Steps performed (in order):
 *   1. Allocate a uniquely-named table via `randomTableName('run-test')`.
 *   2. `createTestTable` — provision the table and wait for ACTIVE status.
 *   3. `bootstrapMigrationState` — write the initial `_migration_state` row.
 *   4. `seedV1Records` — insert `recordCount` v1 User rows (default: 0).
 *   5. Return the setup bundle including a `cleanup` closure.
 *
 * @param args.recordCount - Number of v1 User records to seed (default: 0).
 * @param args.tableName   - Override the auto-generated table name (optional).
 * @returns A fully-initialized `ApplyTestTableSetup`.
 */
export async function setupApplyTestTable(args: { recordCount?: number; tableName?: string } = {}): Promise<ApplyTestTableSetup> {
  const { recordCount = 0, tableName: suppliedName } = args;

  const tableName = suppliedName ?? randomTableName('run-test');
  const { raw, doc } = makeDdbLocalClient();

  await createTestTable(raw, tableName);
  await bootstrapMigrationState(doc, tableName);

  const v1Entity = createUserV1(doc, tableName);
  const v2Entity = createUserV2(doc, tableName);
  const migration = createUserAddStatusMigration(doc, tableName);
  const service = createMigrationsService(doc, tableName);

  if (recordCount > 0) {
    await seedV1Records(v1Entity, recordCount);
  }

  const cleanup = async (): Promise<void> => {
    await deleteTestTable(raw, tableName);
  };

  return { service, tableName, raw, doc, v1Entity, v2Entity, migration, cleanup };
}
