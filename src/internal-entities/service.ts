import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Service } from 'electrodb';
import type { InternalEntityOptions } from './types.js';
import { createMigrationRunsEntity, type MigrationRunsEntity } from './migration-runs.js';
import { createMigrationStateEntity, type MigrationStateEntity } from './migration-state.js';
import { createMigrationsEntity, type MigrationsEntity } from './migrations.js';

/**
 * Wraps the three internal entities in an ElectroDB `Service` so the
 * lifecycle modules can run cross-entity `TransactWriteItems` via
 * `service.transaction.write` (e.g. flip a migration to `applied`, append to
 * its run record, and clear the lock row in one atomic transaction).
 *
 * The keys (`migrations`, `migrationState`, `migrationRuns`) are the names
 * exposed inside the transaction callback:
 *
 * ```ts
 * service.transaction.write(({ migrations, migrationState, migrationRuns }) => ...);
 * ```
 *
 * **ARCHITECTURE Anti-Pattern 6 reminder:** Construct the service ONCE per
 * `createMigrationsClient` call — never inside lock/state-mutation hot paths.
 */
export const createMigrationsService = (client: DynamoDBDocumentClient, table: string, options?: InternalEntityOptions) => {
  const migrations = createMigrationsEntity(client, table, options);
  const migrationState = createMigrationStateEntity(client, table, options);
  const migrationRuns = createMigrationRunsEntity(client, table, options);

  const service = new Service({ migrations, migrationState, migrationRuns }, { client, table });

  return { service, migrations, migrationState, migrationRuns };
};

/**
 * Bundle returned by {@link createMigrationsService} — the service plus its
 * three entities. Every `state-mutations/*.ts` verb accepts this shape as its
 * first argument.
 */
export type MigrationsServiceBundle = {
  service: ReturnType<typeof createMigrationsService>['service'];
  migrations: MigrationsEntity;
  migrationState: MigrationStateEntity;
  migrationRuns: MigrationRunsEntity;
};
