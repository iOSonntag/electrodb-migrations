/**
 * ENT-06 — `createMigrationsService` transactWrite roundtrip against DDB Local.
 *
 * Proves the Service factory produced by Plan 03-02 successfully composes the
 * three internal entities into a single ElectroDB `Service` whose
 * `transaction.write([...])` lands a 3-item TransactWriteItems atomically and
 * the rows are consistently readable afterwards.
 *
 * Skips cleanly when DDB Local is not reachable (tests/integration/_helpers/
 * docker-availability.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_SCHEMA_VERSION, MIGRATION_RUNS_SCHEMA_VERSION, MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, createMigrationsService } from '../../../src/internal-entities/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

describe('createMigrationsService transactWrite (ENT-06)', () => {
  const tableName = randomTableName('ent-06');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('writes 3 items atomically and reads them back consistently', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const bundle = createMigrationsService(doc, tableName);
    const now = new Date().toISOString();

    await bundle.service.transaction
      .write(({ migrationState, migrations, migrationRuns }) => [
        migrationState
          .put({
            id: MIGRATION_STATE_ID,
            schemaVersion: STATE_SCHEMA_VERSION,
            updatedAt: now,
            lockState: 'apply',
            lockHolder: 'test-holder',
            lockRunId: 'r-int-1',
            lockMigrationId: 'mig-int-1',
            lockAcquiredAt: now,
            heartbeatAt: now,
            inFlightIds: ['mig-int-1'],
          })
          .commit(),
        migrations
          .put({
            id: 'mig-int-1',
            schemaVersion: MIGRATIONS_SCHEMA_VERSION,
            kind: 'transform',
            status: 'pending',
            entityName: 'User',
            fromVersion: '1',
            toVersion: '2',
            fingerprint: 'sha256-abc',
          })
          .commit(),
        migrationRuns
          .put({
            runId: 'r-int-1',
            schemaVersion: MIGRATION_RUNS_SCHEMA_VERSION,
            command: 'apply',
            status: 'running',
            migrationId: 'mig-int-1',
            startedAt: now,
            startedBy: 'test-holder',
          })
          .commit(),
      ])
      .go();

    const stateRow = await bundle.migrationState.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
    expect(stateRow.data?.lockState).toBe('apply');
    expect(stateRow.data?.lockRunId).toBe('r-int-1');
    expect(stateRow.data?.lockMigrationId).toBe('mig-int-1');

    const migRow = await bundle.migrations.get({ id: 'mig-int-1' }).go({ consistent: true });
    expect(migRow.data?.entityName).toBe('User');
    expect(migRow.data?.status).toBe('pending');
    expect(migRow.data?.fromVersion).toBe('1');
    expect(migRow.data?.toVersion).toBe('2');

    const runRow = await bundle.migrationRuns.get({ runId: 'r-int-1' }).go({ consistent: true });
    expect(runRow.data?.status).toBe('running');
    expect(runRow.data?.command).toBe('apply');
    expect(runRow.data?.migrationId).toBe('mig-int-1');
  }, 30_000);
});
