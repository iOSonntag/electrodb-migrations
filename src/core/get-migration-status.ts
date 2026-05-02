import type { MigrationsEntity } from '../entities/migrations.js';
import type { MigrationRecord } from '../types.js';

// Reads a single row from the _migrations entity. Read-only, no lock.
// Returns undefined if no row matches the id.
export const getMigrationStatus = async (
  migrations: MigrationsEntity,
  migrationId: string,
): Promise<MigrationRecord | undefined> => {
  const row = await migrations.get({ id: migrationId }).go({ consistent: true });
  if (!row.data) return undefined;
  return row.data as unknown as MigrationRecord;
};
