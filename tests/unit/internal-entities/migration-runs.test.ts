import { Entity } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { MIGRATION_RUNS_SCHEMA_VERSION, createMigrationRunsEntity } from '../../../src/internal-entities/migration-runs.js';
import { parsedAttribute, parsedModel } from './_introspect.js';

// See migration-state.test.ts for stub rationale.
const stubClient = { send: () => {} } as never;

describe('createMigrationRunsEntity (ENT-01, ENT-04, ENT-05)', () => {
  it('returns an Entity instance', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    expect(entity).toBeInstanceOf(Entity);
  });

  it('uses model.service "_electrodb_migrations" and entity "_migration_runs" (ENT-05)', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    const model = parsedModel(entity);
    expect(model.service).toBe('_electrodb_migrations');
    expect(model.entity).toBe('_migration_runs');
    expect(model.version).toBe('1');
  });

  it('exposes the lastHeartbeatAt delta attribute (ENT-04)', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    const attr = parsedAttribute(entity, 'lastHeartbeatAt');
    expect(attr).toBeDefined();
    expect(attr.type).toBe('string');
  });

  it('preserves the existing run-record attributes', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    const attrs = parsedModel(entity).schema.attributes;
    for (const name of ['runId', 'schemaVersion', 'command', 'status', 'migrationId', 'startedAt', 'completedAt', 'startedBy', 'error']) {
      expect(attrs).toHaveProperty(name);
    }
  });

  it('command enum is exactly [apply, rollback, finalize]', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    const command = parsedAttribute(entity, 'command');
    expect(command.type).toBe('enum');
    expect(new Set(command.enumArray)).toEqual(new Set(['apply', 'rollback', 'finalize']));
  });

  it('uses runId as the byRunId partition key composite (ENT-04)', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table');
    const model = parsedModel(entity);
    expect(model.indexes.byRunId?.pk.field).toBe('pk');
    expect(model.indexes.byRunId?.sk.field).toBe('sk');
  });

  it('respects keyFields override (ENT-05)', () => {
    const entity = createMigrationRunsEntity(stubClient, 'test-table', {
      keyFields: { pk: 'PK', sk: 'SK' },
    });
    const model = parsedModel(entity);
    expect(model.indexes.byRunId?.pk.field).toBe('PK');
    expect(model.indexes.byRunId?.sk.field).toBe('SK');
  });
});

describe('MIGRATION_RUNS_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(MIGRATION_RUNS_SCHEMA_VERSION).toBe(1);
  });
});
