import { Entity, Service } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { createMigrationsService } from '../../../src/internal-entities/service.js';
import { parsedModel, serviceEntities } from './_introspect.js';

// See migration-state.test.ts for stub rationale.
const stubClient = { send: () => {} } as never;

describe('createMigrationsService (ENT-06)', () => {
  it('returns a bundle with service + 3 entities', () => {
    const bundle = createMigrationsService(stubClient, 'test-table');
    expect(bundle).toEqual(
      expect.objectContaining({
        service: expect.any(Service),
        migrations: expect.any(Entity),
        migrationState: expect.any(Entity),
        migrationRuns: expect.any(Entity),
      }),
    );
  });

  it('the bundle exposes exactly four keys (no extras, no leak)', () => {
    const bundle = createMigrationsService(stubClient, 'test-table');
    expect(new Set(Object.keys(bundle))).toEqual(new Set(['service', 'migrations', 'migrationState', 'migrationRuns']));
  });

  it('the Service registers exactly the three entity keys', () => {
    const { service } = createMigrationsService(stubClient, 'test-table');
    // ElectroDB Service exposes registered entities as `service.entities` (a record).
    // (verified against `.research/electrodb/src/service.js:84,280`).
    const entities = serviceEntities(service);
    expect(new Set(Object.keys(entities))).toEqual(new Set(['migrations', 'migrationState', 'migrationRuns']));
  });

  it('the entities on the bundle are the SAME instances registered on the service (ENT-06; build-once)', () => {
    const bundle = createMigrationsService(stubClient, 'test-table');
    const registered = serviceEntities(bundle.service);
    expect(registered.migrations).toBe(bundle.migrations);
    expect(registered.migrationState).toBe(bundle.migrationState);
    expect(registered.migrationRuns).toBe(bundle.migrationRuns);
  });

  it('two calls produce two bundles each with their own entity references (no shared mutable state)', () => {
    const a = createMigrationsService(stubClient, 'test-table');
    const b = createMigrationsService(stubClient, 'test-table');
    expect(a.service).not.toBe(b.service);
    expect(a.migrations).not.toBe(b.migrations);
    expect(a.migrationState).not.toBe(b.migrationState);
    expect(a.migrationRuns).not.toBe(b.migrationRuns);
  });

  it('every registered entity advertises model.service "_electrodb_migrations" (ENT-05)', () => {
    const { migrations, migrationState, migrationRuns } = createMigrationsService(stubClient, 'test-table');
    expect(parsedModel(migrations).service).toBe('_electrodb_migrations');
    expect(parsedModel(migrationState).service).toBe('_electrodb_migrations');
    expect(parsedModel(migrationRuns).service).toBe('_electrodb_migrations');
  });

  it('forwards keyFields override to every registered entity', () => {
    const bundle = createMigrationsService(stubClient, 'test-table', {
      keyFields: { pk: 'PK', sk: 'SK' },
    });
    expect(parsedModel(bundle.migrations).indexes.byId?.pk.field).toBe('PK');
    expect(parsedModel(bundle.migrationState).indexes.byId?.pk.field).toBe('PK');
    expect(parsedModel(bundle.migrationRuns).indexes.byRunId?.pk.field).toBe('PK');
  });
});
