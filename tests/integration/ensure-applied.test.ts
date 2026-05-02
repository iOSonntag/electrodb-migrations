import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/core/apply-migrations.js';
import { ensureMigrationsApplied } from '../../src/core/ensure-migrations-applied.js';
import { finalizeMigration } from '../../src/core/finalize-migration.js';
import { ElectroDBMigrationError, FingerprintMismatchError } from '../../src/errors.js';
import { buildContext } from './helpers/build-context.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { createUserMigration, createUserV1, seedV1 } from './helpers/fixtures.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'ensure-test-table';

const ctx = () => buildContext(docClient, TABLE, { appliedBy: 'ensure-test:1' });

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('ensureMigrationsApplied', () => {
  it('passes in verify mode when all migrations are finalized', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await applyMigrations(c, { migrations: [migration] });
    await finalizeMigration(c, { migration });

    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'verify' }),
    ).resolves.toBeUndefined();
  });

  it('passes in verify mode when migrations are applied (not yet finalized)', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await applyMigrations(c, { migrations: [migration] });

    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'verify' }),
    ).resolves.toBeUndefined();
  });

  it('throws in strict mode when migrations are applied but not finalized', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);
    await applyMigrations(c, { migrations: [migration] });

    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'strict' }),
    ).rejects.toBeInstanceOf(ElectroDBMigrationError);
  });

  it('throws when any migration is pending or missing in either mode', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    // No apply has run — migration row absent.
    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'verify' }),
    ).rejects.toBeInstanceOf(ElectroDBMigrationError);
    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'strict' }),
    ).rejects.toBeInstanceOf(ElectroDBMigrationError);
  });

  it('throws FingerprintMismatchError when stored fingerprint differs from current schema', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 1);
    await applyMigrations(c, { migrations: [migration] });

    // Tamper with the fingerprint to simulate schema drift.
    await c.migrationsEntity
      .update({ id: migration.id })
      .set({ fingerprint: 'tampered-fingerprint' })
      .go();

    await expect(
      ensureMigrationsApplied(c, { migrations: [migration], mode: 'verify' }),
    ).rejects.toBeInstanceOf(FingerprintMismatchError);
  });
});
