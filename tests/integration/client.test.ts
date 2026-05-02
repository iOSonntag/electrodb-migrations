import { beforeEach, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../src/core/client.js';
import { bootstrapStateRow, getStateRow } from '../../src/core/lock.js';
import {
  MIGRATION_STATE_ID,
  createMigrationStateEntity,
} from '../../src/entities/migration-state.js';
import { ElectroDBMigrationError } from '../../src/errors.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { createUserMigration, createUserV1, seedV1 } from './helpers/fixtures.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'client-test-table';

const newClient = () =>
  createMigrationsClient({
    client: docClient,
    table: TABLE,
    appliedBy: 'client-test:1',
    staleThresholdMs: 60_000,
    heartbeatMs: 200,
    acquireWaitMs: 50,
  });

const seedLockState = async (refId: string, heldBy: string) => {
  const stateEntity = createMigrationStateEntity(docClient, TABLE);
  await bootstrapStateRow(stateEntity);
  const now = new Date().toISOString();
  await stateEntity
    .update({ id: MIGRATION_STATE_ID })
    .set({
      lockHolder: heldBy,
      lockRefId: refId,
      lockOperation: 'apply',
      lockMigrationId: 'm1',
      lockAcquiredAt: now,
      heartbeatAt: now,
      updatedAt: now,
    })
    .go();
};

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('createMigrationsClient — full lifecycle', () => {
  it('apply → finalize → status reflects each step', async () => {
    const migrate = newClient();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 4);

    await migrate.apply({ migrations: [migration], autoRelease: true });
    let status = await migrate.getStatus({ migrationId: migration.id });
    expect(status?.status).toBe('applied');

    await migrate.finalize({ migration });
    status = await migrate.getStatus({ migrationId: migration.id });
    expect(status?.status).toBe('finalized');
  });

  it('apply → rollback flips to reverted', async () => {
    const migrate = newClient();
    const migration = createUserMigration(docClient, TABLE);
    const v1 = createUserV1(docClient, TABLE);
    await seedV1(v1, 2);

    await migrate.apply({ migrations: [migration], autoRelease: true });
    await migrate.rollback({ migration, autoRelease: true });
    const status = await migrate.getStatus({ migrationId: migration.id });
    expect(status?.status).toBe('reverted');
  });
});

describe('getLockState', () => {
  it('returns locked: false on a fresh table', async () => {
    const migrate = newClient();
    const state = await migrate.getLockState();
    expect(state).toEqual({ locked: false });
  });

  it('reflects an active lock written by another runner', async () => {
    const migrate = newClient();
    await seedLockState('r1', 'someone');

    const state = await migrate.getLockState();
    expect(state.locked).toBe(true);
    if (!state.locked) throw new Error('unreachable');
    expect(state.heldBy).toBe('someone');
    expect(state.operation).toBe('apply');
  });
});

describe('getGuardState', () => {
  it('returns { blocked: false } when nothing is happening and no failures', async () => {
    const migrate = newClient();
    const state = await migrate.getGuardState();
    expect(state).toEqual({ blocked: false });
  });

  it('returns reasons=[locked] when a runner is active', async () => {
    const migrate = newClient();
    await seedLockState('r1', 'someone');

    const state = await migrate.getGuardState();
    expect(state.blocked).toBe(true);
    if (!state.blocked) throw new Error('unreachable');
    expect(state.reasons).toEqual(['locked']);
    expect(state.lock?.heldBy).toBe('someone');
  });

  it('returns reasons=[failed-migration] when a row has status=failed and no lock', async () => {
    const migrate = newClient();
    await migrate.migrationsEntity
      .put({
        id: 'broken-mig',
        status: 'failed',
        fromVersion: '1',
        toVersion: '2',
        entityName: 'User',
        fingerprint: 'sha-x',
        error: 'boom',
      })
      .go();
    // Reflect that into the aggregate row.
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ failedIds: ['broken-mig'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    const state = await migrate.getGuardState();
    expect(state.blocked).toBe(true);
    if (!state.blocked) throw new Error('unreachable');
    expect(state.reasons).toEqual(['failed-migration']);
    expect(state.failedMigrations).toBeDefined();
    expect(state.failedMigrations?.map((m) => m.id)).toEqual(['broken-mig']);
    expect(state.failedMigrations?.[0]?.error).toBe('boom');
  });

  it('returns reasons=[deployment-block] for an open deployment block', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: ['blocked-mig'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    const state = await migrate.getGuardState();
    expect(state.blocked).toBe(true);
    if (!state.blocked) throw new Error('unreachable');
    expect(state.reasons).toEqual(['deployment-block']);
    expect(state.deploymentBlockedIds).toEqual(['blocked-mig']);
  });

  it('returns all three reasons when lock + failed + deployment-block are present', async () => {
    const migrate = newClient();
    await migrate.migrationsEntity
      .put({
        id: 'broken-mig',
        status: 'failed',
        fromVersion: '1',
        toVersion: '2',
        entityName: 'User',
        fingerprint: 'sha-x',
      })
      .go();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    const now = new Date().toISOString();
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockHolder: 'someone',
        lockRefId: 'r1',
        lockOperation: 'apply',
        lockMigrationId: 'm1',
        lockAcquiredAt: now,
        heartbeatAt: now,
        updatedAt: now,
      })
      .add({ failedIds: ['broken-mig'], deploymentBlockedIds: ['blocked-mig'] })
      .go();

    const state = await migrate.getGuardState();
    expect(state.blocked).toBe(true);
    if (!state.blocked) throw new Error('unreachable');
    expect(state.reasons).toContain('locked');
    expect(state.reasons).toContain('failed-migration');
    expect(state.reasons).toContain('deployment-block');
  });
});

describe('releaseDeploymentBlock', () => {
  it('removes one entry from deploymentBlockedIds', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: ['m1', 'm2'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await migrate.releaseDeploymentBlock({ migrationId: 'm1' });

    const row = await getStateRow(stateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toEqual(['m2']);
  });

  it('refuses to run while a runner mutex is active', async () => {
    const migrate = newClient();
    await seedLockState('r1', 'someone');

    await expect(migrate.releaseDeploymentBlock({ migrationId: 'm1' })).rejects.toBeInstanceOf(
      ElectroDBMigrationError,
    );
  });
});

describe('releaseAllDeploymentBlocks', () => {
  it('clears every entry from deploymentBlockedIds', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: ['m1', 'm2', 'm3'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await migrate.releaseAllDeploymentBlocks();

    const row = await getStateRow(stateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toEqual([]);
  });

  it('refuses to run while a runner mutex is active', async () => {
    const migrate = newClient();
    await seedLockState('r1', 'someone');

    await expect(migrate.releaseAllDeploymentBlocks()).rejects.toBeInstanceOf(
      ElectroDBMigrationError,
    );
  });
});

describe('reconcileState', () => {
  it('rebuilds failedIds from the audit table', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);

    // Seed audit rows: one applied, one failed, one finalized.
    await migrate.migrationsEntity
      .put([
        {
          id: 'mig-applied',
          status: 'applied' as const,
          fromVersion: '1',
          toVersion: '2',
          entityName: 'User',
          fingerprint: 'a',
        },
        {
          id: 'mig-failed',
          status: 'failed' as const,
          fromVersion: '1',
          toVersion: '2',
          entityName: 'User',
          fingerprint: 'b',
        },
        {
          id: 'mig-finalized',
          status: 'finalized' as const,
          fromVersion: '1',
          toVersion: '2',
          entityName: 'User',
          fingerprint: 'c',
        },
      ])
      .go();

    // Seed an out-of-date aggregate row with bogus failedIds.
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ failedIds: ['ghost-id'], inFlightIds: ['stale-id'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await migrate.reconcileState();

    const row = await getStateRow(stateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.failedIds).toEqual(['mig-failed']);
    expect(row.inFlightIds).toEqual([]);
  });

  it('preserves deploymentBlockedIds (operator intent)', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await bootstrapStateRow(stateEntity);
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: ['blocked-mig'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await migrate.reconcileState();

    const row = await getStateRow(stateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain('blocked-mig');
  });

  it('refuses to run while a runner mutex is active', async () => {
    const migrate = newClient();
    await seedLockState('r1', 'someone');

    await expect(migrate.reconcileState()).rejects.toBeInstanceOf(ElectroDBMigrationError);
  });
});

describe('forceUnlock', () => {
  it('clears the lock fields regardless of refId', async () => {
    const migrate = newClient();
    await seedLockState('attacker', 'attacker');

    await migrate.forceUnlock();

    const state = await migrate.getLockState();
    expect(state).toEqual({ locked: false });
  });

  it('preserves failedIds and deploymentBlockedIds', async () => {
    const migrate = newClient();
    const stateEntity = createMigrationStateEntity(docClient, TABLE);
    await seedLockState('attacker', 'attacker');
    await stateEntity
      .update({ id: MIGRATION_STATE_ID })
      .add({ failedIds: ['mig-fail'], deploymentBlockedIds: ['mig-block'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await migrate.forceUnlock();

    const row = await getStateRow(stateEntity);
    if (!row) throw new Error('unreachable');
    expect(row.failedIds).toContain('mig-fail');
    expect(row.deploymentBlockedIds).toContain('mig-block');
  });
});
