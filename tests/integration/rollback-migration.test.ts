import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/core/apply-migrations.js';
import { defineMigration } from '../../src/core/define-migration.js';
import { finalizeMigration } from '../../src/core/finalize-migration.js';
import { getMigrationStatus } from '../../src/core/get-migration-status.js';
import { getStateRow } from '../../src/core/lock.js';
import { rollbackMigration } from '../../src/core/rollback-migration.js';
import { MigrationFailedError, RollbackNotPossibleError } from '../../src/errors.js';
import { buildContext } from './helpers/build-context.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { createUserMigration, createUserV1, createUserV2, seedV1 } from './helpers/fixtures.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'rollback-test-table';

const ctx = () => buildContext(docClient, TABLE, { appliedBy: 'rollback-test:1' });

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('rollbackMigration', () => {
  it('pre-finalize rollback from applied: deletes v2, leaves v1, status=reverted', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 8);

    await applyMigrations(c, { migrations: [migration] });
    await rollbackMigration(c, { migration });

    const v1After = await v1.scan.go({ pages: 'all' });
    const v2After = await v2.scan.go({ pages: 'all' });
    expect(v1After.data.length).toBe(8);
    expect(v2After.data.length).toBe(0);

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('reverted');
    expect(status?.revertedAt).toBeDefined();
  });

  it('pre-finalize rollback from failed: deletes any partial v2, status=reverted', async () => {
    const c = ctx();
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 5);

    // Run a migration that fails — but seed some partial v2 records first
    // so we can verify rollback cleans them up.
    await v2
      .put([
        { id: 'user-0000', email: 'user0@example.com', status: 'active' as const },
        { id: 'user-0001', email: 'user1@example.com', status: 'active' as const },
      ])
      .go();

    const broken = defineMigration({
      id: '20260428-rollback-failed',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async () => {
        throw new Error('fail');
      },
    });

    await expect(applyMigrations(c, { migrations: [broken] })).rejects.toBeInstanceOf(
      MigrationFailedError,
    );

    await rollbackMigration(c, { migration: broken });
    const v2After = await v2.scan.go({ pages: 'all' });
    expect(v2After.data.length).toBe(0);

    const status = await getMigrationStatus(c.migrationsEntity, broken.id);
    expect(status?.status).toBe('reverted');
  });

  it('post-finalize rollback rebuilds v1 from v2 via down() and deletes v2', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 4);

    await applyMigrations(c, { migrations: [migration] });
    await finalizeMigration(c, { migration });

    // After finalize: only v2 records exist.
    const beforeRollback = await v1.scan.go({ pages: 'all' });
    expect(beforeRollback.data.length).toBe(0);

    await rollbackMigration(c, { migration });

    const v1After = await v1.scan.go({ pages: 'all' });
    const v2After = await v2.scan.go({ pages: 'all' });
    expect(v1After.data.length).toBe(4);
    expect(v2After.data.length).toBe(0);

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('reverted');
  });

  it('post-finalize rollback without down() throws RollbackNotPossibleError', async () => {
    const c = ctx();
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 2);

    const noDown = defineMigration({
      id: '20260428-no-down',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async (item) => ({ ...item, status: 'active' as const }),
      // No down().
    });

    await applyMigrations(c, { migrations: [noDown] });
    await finalizeMigration(c, { migration: noDown });

    try {
      await rollbackMigration(c, { migration: noDown });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RollbackNotPossibleError);
      expect((err as RollbackNotPossibleError).reason).toBe('no-down-fn');
    }
  });

  it('throws RollbackNotPossibleError when already reverted', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await applyMigrations(c, { migrations: [migration] });
    await rollbackMigration(c, { migration });

    try {
      await rollbackMigration(c, { migration });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RollbackNotPossibleError);
      expect((err as RollbackNotPossibleError).reason).toBe('already-reverted');
    }
  });

  it('is a no-op when migration row does not exist or is pending', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    // No row, no apply — rollback is a no-op.
    await expect(rollbackMigration(c, { migration })).resolves.toBeUndefined();

    // Pre-create row in pending status.
    await c.migrationsEntity
      .put({
        id: migration.id,
        status: 'pending',
        fromVersion: '1',
        toVersion: '2',
        entityName: 'User',
        fingerprint: 'placeholder',
      })
      .go();
    await expect(rollbackMigration(c, { migration })).resolves.toBeUndefined();
  });

  it('rollback clears failedIds and the lock on success', async () => {
    const c = ctx();
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 3);

    const broken = defineMigration({
      id: '20260428-rollback-clears-failed',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async () => {
        throw new Error('boom');
      },
    });

    await expect(applyMigrations(c, { migrations: [broken] })).rejects.toBeInstanceOf(
      MigrationFailedError,
    );

    let row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.failedIds).toContain(broken.id);

    await rollbackMigration(c, { migration: broken });

    row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.failedIds).not.toContain(broken.id);
    expect(row.lockRefId).toBeUndefined();
  });

  it('autoRelease=false (default) leaves a deployment block on rollback success', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await applyMigrations(c, { migrations: [migration], autoRelease: true });
    await rollbackMigration(c, { migration });

    const row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain(migration.id);
  });

  it('autoRelease=true clears any deployment block on rollback success', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    // Apply with autoRelease=false to seed a block.
    await applyMigrations(c, { migrations: [migration] });
    let row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain(migration.id);

    await rollbackMigration(c, { migration, autoRelease: true });
    row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).not.toContain(migration.id);
  });
});
