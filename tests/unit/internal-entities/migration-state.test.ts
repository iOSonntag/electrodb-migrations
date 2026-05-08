import { Entity } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, createMigrationStateEntity } from '../../../src/internal-entities/migration-state.js';
import { parsedAttribute, parsedModel } from './_introspect.js';

// ElectroDB validates the client *at construct time* (`normalizeClient` in
// `electrodb/src/client.js:285`) by sniffing for either v2 (`get`/`put`/...) or
// v3 (`send`) DocumentClient methods. A bare `{}` throws InvalidClientProvided;
// the smallest stub that passes is an object exposing a `send` function (v3 shape).
// We don't issue any calls, so `send` never runs.
const stubClient = { send: () => {} } as never;

describe('createMigrationStateEntity (ENT-01, ENT-02, ENT-05)', () => {
  it('returns an Entity instance', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table');
    expect(entity).toBeInstanceOf(Entity);
  });

  it('uses model.service "_electrodb_migrations" and entity "_migration_state" (ENT-05)', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table');
    const model = parsedModel(entity);
    expect(model.service).toBe('_electrodb_migrations');
    expect(model.entity).toBe('_migration_state');
    expect(model.version).toBe('1');
  });

  it('lockState enum includes all seven values incl. "dying" (ENT-02)', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table');
    const lockState = parsedAttribute(entity, 'lockState');
    expect(lockState.type).toBe('enum');
    expect(new Set(lockState.enumArray)).toEqual(new Set(['free', 'apply', 'finalize', 'rollback', 'release', 'failed', 'dying']));
  });

  it('lockState is required (ENT-02 — guard cannot read absent value)', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table');
    const lockState = parsedAttribute(entity, 'lockState');
    expect(lockState.required).toBe(true);
  });

  it('uses default pk/sk field names "pk"/"sk" when keyFields not supplied', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table');
    const model = parsedModel(entity);
    expect(model.indexes.byId?.pk.field).toBe('pk');
    expect(model.indexes.byId?.sk.field).toBe('sk');
  });

  it('respects keyFields.pk / keyFields.sk override (ENT-05)', () => {
    const entity = createMigrationStateEntity(stubClient, 'test-table', {
      keyFields: { pk: 'PK', sk: 'SK' },
    });
    const model = parsedModel(entity);
    expect(model.indexes.byId?.pk.field).toBe('PK');
    expect(model.indexes.byId?.sk.field).toBe('SK');
  });

  it('forwards identifiers only when explicitly supplied (CFG-05; ENT-05)', () => {
    // Both forms construct without throwing.
    expect(() => createMigrationStateEntity(stubClient, 'test-table')).not.toThrow();
    expect(() =>
      createMigrationStateEntity(stubClient, 'test-table', {
        identifiers: { entity: 'eMarker', version: 'vMarker' },
      }),
    ).not.toThrow();
    // The forwarded identifiers should land on the entity's underlying configuration. The most
    // robust check available without a DDB call is that the JSON-stringified entity contains the
    // literal identifier strings ONLY when they were supplied.
    const noIds = JSON.stringify(createMigrationStateEntity(stubClient, 'test-table'));
    const withIds = JSON.stringify(
      createMigrationStateEntity(stubClient, 'test-table', {
        identifiers: { entity: 'eMarker', version: 'vMarker' },
      }),
    );
    expect(noIds).not.toContain('eMarker');
    expect(withIds).toContain('eMarker');
    expect(withIds).toContain('vMarker');
  });
});

describe('MIGRATION_STATE_ID + STATE_SCHEMA_VERSION (ENT-01)', () => {
  it('MIGRATION_STATE_ID is the literal "state"', () => {
    expect(MIGRATION_STATE_ID).toBe('state');
  });

  it('STATE_SCHEMA_VERSION is 1', () => {
    expect(STATE_SCHEMA_VERSION).toBe(1);
  });
});
