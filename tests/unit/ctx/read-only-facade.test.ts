/**
 * Unit tests for `createReadOnlyFacade` — covers CTX-02, CTX-03.
 *
 * RED phase: written before the implementation and expected to FAIL at import
 * time because `src/ctx/read-only-facade.ts` does not exist yet.
 *
 * CTX-02: facade exposes read methods bound to the unguarded client + table.
 *   - get, query, scan, find, match, parse are accessible.
 *   - facade.get({id:'x'}).params().TableName equals the passed tableName.
 * CTX-03: write methods throw with [electrodb-migrations] prefix before any DDB call.
 *   - put, create, upsert, update, patch, delete, remove all throw.
 *
 * Wave 1 (Plan 06-02) removes the @ts-expect-error comment on the import and
 * implements createReadOnlyFacade. The tests then flip from RED to GREEN.
 *
 * RESEARCH §Pattern 2, §OQ1 (Pitfall 2: query/scan are namespace objects).
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — Plan 06-02 ships src/ctx/read-only-facade.ts; remove this directive when the file lands.
import { createReadOnlyFacade } from '../../../src/ctx/read-only-facade.js';
import { Entity } from 'electrodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubClient(): DynamoDBDocumentClient {
  return { send: vi.fn() } as unknown as DynamoDBDocumentClient;
}

/**
 * Create a real ElectroDB Entity with a known schema. Used because
 * createReadOnlyFacade calls `new Entity(entity.schema, {client, table})`
 * internally — requires a real entity with a `.schema` property.
 */
function makeTestEntity(client: DynamoDBDocumentClient, table: string) {
  return new Entity(
    {
      model: { entity: 'TestUser', version: '1', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client, table },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createReadOnlyFacade', () => {
  // ----- CTX-03: write methods throw -----

  describe('CTX-03: write methods throw before any DDB call', () => {
    it.each(['put', 'create', 'upsert', 'update', 'patch', 'delete', 'remove'])(
      '"%s" throws with [electrodb-migrations] prefix (no DDB call)',
      (method) => {
        const entity = makeTestEntity(makeStubClient(), 'test-table');
        const facade = createReadOnlyFacade(entity, makeStubClient(), 'facade-table');
        // biome-ignore lint/suspicious/noExplicitAny: facade is any due to @ts-expect-error import; cast for write-method invocation test.
        expect(() => (facade as any)[method]()).toThrow('[electrodb-migrations]');
      },
    );
  });

  // ----- CTX-02: read methods are accessible -----

  describe('CTX-02: facade exposes read methods', () => {
    it('exposes get, query, scan, find, match, parse on the facade', () => {
      const entity = makeTestEntity(makeStubClient(), 'test-table');
      const facade = createReadOnlyFacade(entity, makeStubClient(), 'facade-table');

      // get, find, match, parse should be callable functions
      expect(typeof facade.get).toBe('function');
      expect(typeof facade.find).toBe('function');
      expect(typeof facade.match).toBe('function');
      expect(typeof facade.parse).toBe('function');

      // query and scan are namespace objects (Pitfall 2 — not callable, but defined)
      expect(facade.query).toBeDefined();
      expect(facade.scan).toBeDefined();
    });
  });

  // ----- CTX-02: facade is bound to the passed client + table -----

  describe('CTX-02: facade routes through the bound client + table', () => {
    it('facade.get({id}).params().TableName equals the passed tableName', () => {
      const entity = makeTestEntity(makeStubClient(), 'original-table');
      const facade = createReadOnlyFacade(entity, makeStubClient(), 'facade-table');

      // .params() returns the DDB params WITHOUT issuing a real DDB call
      const params = facade.get({ id: 'test-id' }).params();
      expect(params.TableName).toBe('facade-table');
    });
  });
});
