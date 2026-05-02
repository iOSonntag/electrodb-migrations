import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/core/apply-migrations.js';
import { defineMigration } from '../../src/core/define-migration.js';
import { getMigrationStatus } from '../../src/core/get-migration-status.js';
import { getStateRow } from '../../src/core/lock.js';
import {
  MIGRATION_STATE_ID,
  createMigrationStateEntity,
} from '../../src/entities/migration-state.js';
import { LockHeldError, MigrationFailedError, RequiresRollbackError } from '../../src/errors.js';
import type { MigrationProgressEvent } from '../../src/types.js';
import { buildContext } from './helpers/build-context.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { createUserMigration, createUserV1, createUserV2, seedV1 } from './helpers/fixtures.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'apply-test-table';

const ctx = () => buildContext(docClient, TABLE, { appliedBy: 'apply-test:1' });

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('applyMigrations', () => {
  it('completes successfully on an empty v1 set', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    await applyMigrations(c, { migrations: [migration] });

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('applied');
    expect(status?.itemCounts?.scanned).toBe(0);
    expect(status?.itemCounts?.migrated).toBe(0);
  });

  it('migrates v1 records to v2 and leaves v1 intact', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 25);

    await applyMigrations(c, { migrations: [migration] });

    const v1Records = await v1.scan.go({ pages: 'all' });
    const v2Records = await v2.scan.go({ pages: 'all' });
    expect(v1Records.data.length).toBe(25);
    expect(v2Records.data.length).toBe(25);
    expect(v2Records.data.every((r) => r.status === 'active')).toBe(true);

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('applied');
    expect(status?.itemCounts?.scanned).toBe(25);
    expect(status?.itemCounts?.migrated).toBe(25);
    expect(status?.appliedBy).toBe('apply-test:1');
    expect(status?.fromVersion).toBe('1');
    expect(status?.toVersion).toBe('2');
  });

  it('handles multi-page scans by paginating through ElectroDB cursors', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 75);

    await applyMigrations(c, { migrations: [migration] });

    const v2Records = await v2.scan.go({ pages: 'all' });
    expect(v2Records.data.length).toBe(75);
    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.itemCounts?.migrated).toBe(75);
  });

  it('sets status=failed and throws MigrationFailedError when up() rejects', async () => {
    const c = ctx();
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 5);

    const migration = defineMigration({
      id: '20260428-broken',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async () => {
        throw new Error('boom');
      },
    });

    await expect(applyMigrations(c, { migrations: [migration] })).rejects.toBeInstanceOf(
      MigrationFailedError,
    );

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('failed');
    expect(status?.error).toContain('boom');
  });

  it('is idempotent when the migration is already applied', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 5);

    await applyMigrations(c, { migrations: [migration] });
    // Second call should skip cleanly without re-scanning.
    await applyMigrations(c, { migrations: [migration] });

    const status = await getMigrationStatus(c.migrationsEntity, migration.id);
    expect(status?.status).toBe('applied');
  });

  it('throws RequiresRollbackError when retrying after a failure', async () => {
    const c = ctx();
    const v1 = createUserV1(docClient, TABLE);
    const v2 = createUserV2(docClient, TABLE);
    await seedV1(v1, 3);

    const broken = defineMigration({
      id: '20260428-broken-retry',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async () => {
        throw new Error('still broken');
      },
    });

    await expect(applyMigrations(c, { migrations: [broken] })).rejects.toBeInstanceOf(
      MigrationFailedError,
    );
    await expect(applyMigrations(c, { migrations: [broken] })).rejects.toBeInstanceOf(
      RequiresRollbackError,
    );
  });

  it('blocks a concurrent apply with LockHeldError', async () => {
    const c2 = ctx();
    // Pre-acquire the runner mutex by writing the state row directly.
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    const now = new Date().toISOString();
    await stateEntity
      .put({
        id: MIGRATION_STATE_ID,
        schemaVersion: 1,
        updatedAt: now,
        lockHolder: 'attacker',
        lockRefId: 'attacker',
        lockOperation: 'apply',
        lockMigrationId: 'attacker-mig',
        lockAcquiredAt: now,
        heartbeatAt: now,
      })
      .go();

    const migration = createUserMigration(docClient, TABLE);
    await expect(applyMigrations(c2, { migrations: [migration] })).rejects.toBeInstanceOf(
      LockHeldError,
    );
  });

  it('autoRelease=false (default) leaves a deployment block on success', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    await applyMigrations(c, { migrations: [migration] });

    const row = await getStateRow(c.migrationStateEntity);
    expect(row).toBeDefined();
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain(migration.id);
    expect(row.lockRefId).toBeUndefined();
  });

  it('autoRelease=true clears the deployment block on success', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    await applyMigrations(c, { migrations: [migration], autoRelease: true });

    const row = await getStateRow(c.migrationStateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).not.toContain(migration.id);
    expect(row.lockRefId).toBeUndefined();
  });

  it('emits onProgress lifecycle events in order', async () => {
    const c = ctx();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 3);

    const events: MigrationProgressEvent['type'][] = [];
    await applyMigrations(c, {
      migrations: [migration],
      onProgress: (e) => events.push(e.type),
    });

    expect(events[0]).toBe('lock-acquired');
    expect(events[1]).toBe('operation-start');
    expect(events).toContain('scan-page');
    expect(events).toContain('transform-batch');
    expect(events).toContain('write-batch');
    expect(events).toContain('operation-complete');
    expect(events.at(-1)).toBe('lock-released');
  });
});
