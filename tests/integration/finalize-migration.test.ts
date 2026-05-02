import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/core/apply-migrations.js';
import { finalizeMigration } from '../../src/core/finalize-migration.js';
import { getMigrationStatus } from '../../src/core/get-migration-status.js';
import { getStateRow } from '../../src/core/lock.js';
import {
  MIGRATION_STATE_ID,
  createMigrationStateEntity,
} from '../../src/entities/migration-state.js';
import { ElectroDBMigrationError, LockHeldError } from '../../src/errors.js';
import { buildContext } from './helpers/build-context.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { createUserMigration, createUserV1, createUserV2, seedV1 } from './helpers/fixtures.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'finalize-test-table';

const ctx = () => buildContext(docClient, TABLE, { appliedBy: 'finalize-test:1' });

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('finalizeMigration', () => {
  it('deletes all v1 records and sets status=finalized', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 12);

    await applyMigrations(c, { migrations: [migration] });
    await finalizeMigration(c, { migration });

    const v1After = await v1.scan.go({ pages: 'all' });
    const v2After = await v2.scan.go({ pages: 'all' });
    expect(v1After.data.length).toBe(0);
    expect(v2After.data.length).toBe(12);

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('finalized');
    expect(status?.finalizedAt).toBeDefined();
  });

  it('throws when status is pending (no applied data to finalize)', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    // Pre-create the row in pending status without running apply.
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

    await expect(finalizeMigration(c, { migration })).rejects.toBeInstanceOf(
      ElectroDBMigrationError,
    );
  });

  it('throws when status is failed', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    await c.migrationsEntity
      .put({
        id: migration.id,
        status: 'failed',
        fromVersion: '1',
        toVersion: '2',
        entityName: 'User',
        fingerprint: 'placeholder',
        error: 'previous run failed',
      })
      .go();

    await expect(finalizeMigration(c, { migration })).rejects.toBeInstanceOf(
      ElectroDBMigrationError,
    );
  });

  it('is idempotent when already finalized', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 3);

    await applyMigrations(c, { migrations: [migration] });
    await finalizeMigration(c, { migration });
    // Second finalize should not throw and not re-process.
    await finalizeMigration(c, { migration });

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('finalized');
  });

  it('blocks when another runner holds the lock', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 3);
    await applyMigrations(c, { migrations: [migration] });

    // Simulate another runner holding the lock by writing the state row directly.
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    const now = new Date().toISOString();
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockHolder: 'attacker',
        lockRefId: 'attacker',
        lockOperation: 'apply',
        lockMigrationId: 'attacker-mig',
        lockAcquiredAt: now,
        heartbeatAt: now,
        updatedAt: now,
      })
      .go();

    await expect(finalizeMigration(c, { migration })).rejects.toBeInstanceOf(LockHeldError);
  });

  it('releases the runner mutex after a successful finalize', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await applyMigrations(c, { migrations: [migration] });
    await finalizeMigration(c, { migration });

    const row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.lockRefId).toBeUndefined();
    expect(row.lockHolder).toBeUndefined();
  });

  it('does not affect deploymentBlockedIds (finalize has no autoRelease semantics)', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    // Apply with autoRelease=false to seed a deployment block.
    await applyMigrations(c, { migrations: [migration] });
    let row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain(migration.id);

    // Finalize should not change the deployment block.
    await finalizeMigration(c, { migration });
    row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain(migration.id);
  });
});
