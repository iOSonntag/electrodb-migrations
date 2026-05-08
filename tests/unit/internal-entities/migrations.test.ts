import { Entity } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_SCHEMA_VERSION, createMigrationsEntity } from '../../../src/internal-entities/migrations.js';
import { parsedAttribute, parsedModel } from './_introspect.js';

// See migration-state.test.ts for stub rationale.
const stubClient = { send: () => {} } as never;

describe('createMigrationsEntity (ENT-01, ENT-03, ENT-05)', () => {
  it('returns an Entity instance', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    expect(entity).toBeInstanceOf(Entity);
  });

  it('uses model.service "_electrodb_migrations" and entity "_migrations" (ENT-05)', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    const model = parsedModel(entity);
    expect(model.service).toBe('_electrodb_migrations');
    expect(model.entity).toBe('_migrations');
    expect(model.version).toBe('1');
  });

  it('exposes the four Phase 3 delta attributes (ENT-03, CTX-06)', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    const attrs = parsedModel(entity).schema.attributes;
    expect(attrs).toHaveProperty('reads');
    expect(attrs).toHaveProperty('rollbackStrategy');
    expect(attrs).toHaveProperty('hasDown');
    expect(attrs).toHaveProperty('hasRollbackResolver');
  });

  it('reads is a set<string>', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    const reads = parsedAttribute(entity, 'reads');
    expect(reads.type).toBe('set');
    // Set items are themselves parsed Attribute objects with `.type`.
    expect(reads.items?.type).toBe('string');
  });

  it('rollbackStrategy enum contains exactly the four strategy values', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    const rollback = parsedAttribute(entity, 'rollbackStrategy');
    expect(rollback.type).toBe('enum');
    expect(new Set(rollback.enumArray)).toEqual(new Set(['projected', 'snapshot', 'fill-only', 'custom']));
  });

  it('hasDown and hasRollbackResolver are booleans', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    expect(parsedAttribute(entity, 'hasDown').type).toBe('boolean');
    expect(parsedAttribute(entity, 'hasRollbackResolver').type).toBe('boolean');
  });

  it('preserves the existing pre-Phase-3 attributes (audit-row contract)', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table');
    const attrs = parsedModel(entity).schema.attributes;
    // The audit-row contract from REQUIREMENTS.md ENT-03: kind, status, fromVersion,
    // toVersion, entityName, fingerprint, itemCounts, error all remain.
    for (const name of ['id', 'schemaVersion', 'kind', 'status', 'fromVersion', 'toVersion', 'entityName', 'fingerprint', 'itemCounts', 'error']) {
      expect(attrs).toHaveProperty(name);
    }
  });

  it('respects keyFields override (ENT-05)', () => {
    const entity = createMigrationsEntity(stubClient, 'test-table', {
      keyFields: { pk: 'PK', sk: 'SK' },
    });
    const model = parsedModel(entity);
    expect(model.indexes.byId?.pk.field).toBe('PK');
    expect(model.indexes.byId?.sk.field).toBe('SK');
  });

  it('forwards identifiers only when explicitly supplied (CFG-05)', () => {
    const noIds = JSON.stringify(createMigrationsEntity(stubClient, 'test-table'));
    const withIds = JSON.stringify(
      createMigrationsEntity(stubClient, 'test-table', {
        identifiers: { entity: 'eMarker', version: 'vMarker' },
      }),
    );
    expect(noIds).not.toContain('eMarker');
    expect(withIds).toContain('eMarker');
    expect(withIds).toContain('vMarker');
  });
});

describe('MIGRATIONS_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(MIGRATIONS_SCHEMA_VERSION).toBe(1);
  });
});
