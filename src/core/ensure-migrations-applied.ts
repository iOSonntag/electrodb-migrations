import { ElectroDBMigrationError, FingerprintMismatchError } from '../errors.js';
import type { EnsureAppliedOptions, MigrationStatus } from '../types.js';
import type { ApplyContext } from './apply-migrations.js';
import { fingerprint } from './fingerprint.js';
import { getMigrationStatus } from './get-migration-status.js';

const acceptableStatuses = (mode: 'verify' | 'strict'): MigrationStatus[] =>
  mode === 'strict' ? ['finalized'] : ['applied', 'finalized'];

// Boot-time guard. Walks every migration the app expects and verifies that:
//   1. its row exists with an acceptable status (verify: applied|finalized; strict: finalized)
//   2. the stored fingerprint matches the current v2 schema (no drift)
//
// Throws on the first failure — fail fast at process start rather than mid-traffic.
export const ensureMigrationsApplied = async (
  ctx: ApplyContext,
  opts: EnsureAppliedOptions,
): Promise<void> => {
  const accepted = acceptableStatuses(opts.mode);

  for (const migration of opts.migrations) {
    const row = await getMigrationStatus(ctx.migrationsEntity, migration.id);
    if (!row) {
      throw new ElectroDBMigrationError(
        `Migration ${migration.id} has no row; expected one of [${accepted.join(', ')}]`,
      );
    }
    if (!accepted.includes(row.status)) {
      throw new ElectroDBMigrationError(
        `Migration ${migration.id} is in status='${row.status}'; expected one of [${accepted.join(', ')}]`,
      );
    }

    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity generic propagation
    const expected = fingerprint((migration.to as any).schema.model);
    if (row.fingerprint !== expected) {
      throw new FingerprintMismatchError({
        migrationId: migration.id,
        expected,
        actual: row.fingerprint,
      });
    }
  }
};
