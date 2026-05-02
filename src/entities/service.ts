import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Service } from 'electrodb';
import type { IdentifiersConfig } from '../types.js';
import { createMigrationStateEntity } from './migration-state.js';
import { createMigrationsEntity } from './migrations.js';

// Wraps the two internal entities in an ElectroDB Service so the lifecycle
// modules can run cross-entity TransactWriteItems via service.transaction.write.
//
// The keys ('migrations', 'migrationState') are the names exposed inside the
// transaction callback: service.transaction.write(({ migrations, migrationState }) => ...).
export const createMigrationsService = (
  client: DynamoDBDocumentClient,
  table: string,
  identifiers?: IdentifiersConfig,
) => {
  const migrations = createMigrationsEntity(client, table, identifiers);
  const migrationState = createMigrationStateEntity(client, table, identifiers);

  const service = new Service({ migrations, migrationState }, { client, table });

  return { service, migrations, migrationState };
};

export type MigrationsServiceBundle = ReturnType<typeof createMigrationsService>;
