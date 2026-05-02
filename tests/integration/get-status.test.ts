import { beforeEach, describe, expect, it } from 'vitest';
import { getMigrationStatus } from '../../src/core/get-migration-status.js';
import { createMigrationsEntity } from '../../src/entities/migrations.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'get-status-test-table';

const makeMigrations = () => createMigrationsEntity(docClient, TABLE);

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('getMigrationStatus', () => {
  it('returns undefined when the migration row does not exist', async () => {
    const m = makeMigrations();
    const result = await getMigrationStatus(m, '20260428-missing');
    expect(result).toBeUndefined();
  });

  it('returns the full migration record when present', async () => {
    const m = makeMigrations();
    await m
      .put({
        id: '20260428-add-status',
        status: 'applied',
        appliedAt: '2026-04-28T12:00:00.000Z',
        appliedBy: 'host-1:42',
        fromVersion: '1',
        toVersion: '2',
        entityName: 'User',
        fingerprint: 'sha-abc',
      })
      .go();

    const result = await getMigrationStatus(m, '20260428-add-status');
    expect(result).toBeDefined();
    expect(result?.id).toBe('20260428-add-status');
    expect(result?.status).toBe('applied');
    expect(result?.appliedAt).toBe('2026-04-28T12:00:00.000Z');
    expect(result?.appliedBy).toBe('host-1:42');
    expect(result?.fromVersion).toBe('1');
    expect(result?.toVersion).toBe('2');
    expect(result?.entityName).toBe('User');
    expect(result?.fingerprint).toBe('sha-abc');
  });

  it('isolates rows by id when multiple migrations exist', async () => {
    const m = makeMigrations();
    await m
      .put([
        {
          id: 'mig-a',
          status: 'applied',
          fromVersion: '1',
          toVersion: '2',
          entityName: 'User',
          fingerprint: 'sha-a',
        },
        {
          id: 'mig-b',
          status: 'finalized',
          fromVersion: '1',
          toVersion: '2',
          entityName: 'Order',
          fingerprint: 'sha-b',
        },
      ])
      .go();

    const a = await getMigrationStatus(m, 'mig-a');
    const b = await getMigrationStatus(m, 'mig-b');
    expect(a?.entityName).toBe('User');
    expect(a?.status).toBe('applied');
    expect(b?.entityName).toBe('Order');
    expect(b?.status).toBe('finalized');
  });
});
