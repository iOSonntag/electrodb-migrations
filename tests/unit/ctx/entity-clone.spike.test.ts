/**
 * WAVE 0 SPIKE TEST — Research Assumption A4 verification.
 *
 * Phase 6 RESEARCH §A4 (high-confidence, MUST verify): the read-only facade
 * approach depends on `new Entity(entity.schema, { client, table })` producing
 * a fully functional clone bound to the new client without mutating the
 * original entity's client reference.
 *
 * If this test fails, the entire `createReadOnlyFacade` strategy is wrong and
 * the planner MUST replan around `Proxy<Entity>` (the rejected option in OQ1)
 * or `setClient` + restore (the pitfall path).
 *
 * Wave 1 (Plans 06-02 + 06-03) is BLOCKED until this test passes.
 *
 * Pitfalls covered:
 *   - Pitfall 1 (RESEARCH lines 551-555): `entity.setClient(...)` mutates the
 *     original entity. The clone path must NOT mutate.
 *   - Pitfall 2 (RESEARCH lines 557-561): `entity.query` and `entity.scan`
 *     are namespace objects, not callable functions. Must be accessible on the
 *     cloned entity.
 */
import { describe, expect, it, vi } from 'vitest';
import { Entity } from 'electrodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

function makeStubClient(): DynamoDBDocumentClient {
  // Minimal shape sufficient for `.params()` — no DDB calls actually fire.
  return { send: vi.fn() } as unknown as DynamoDBDocumentClient;
}

function makeTestEntity(client: DynamoDBDocumentClient, table: string) {
  return new Entity(
    {
      model: { entity: 'SpikeTeam', version: '1', service: 'spike' },
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

describe('A4 spike: new Entity(schema, { client, table }) clone', () => {
  it('produces a functional .get(...).params() builder bound to the new table', () => {
    const stubClient1 = makeStubClient();
    const stubClient2 = makeStubClient();
    const original = makeTestEntity(stubClient1, 'original-table');

    // biome-ignore lint/suspicious/noExplicitAny: schema property exists on Entity at runtime; test crosses the type boundary deliberately.
    const cloned = new Entity((original as any).schema, { client: stubClient2, table: 'cloned-table' });

    const params = cloned.get({ id: 'spike-id' }).params();
    expect(params.TableName).toBe('cloned-table');
    expect(params.Key).toBeDefined();
  });

  it('exposes a query namespace on the clone (Pitfall 2 pin)', () => {
    const original = makeTestEntity(makeStubClient(), 'original');
    // biome-ignore lint/suspicious/noExplicitAny: schema is internal Entity property
    const cloned = new Entity((original as any).schema, { client: makeStubClient(), table: 'cloned' });

    expect(cloned.query).toBeDefined();
    expect(typeof cloned.query.byId).toBe('function');
  });

  it('exposes a scan namespace on the clone (Pitfall 2 pin)', () => {
    const original = makeTestEntity(makeStubClient(), 'original');
    // biome-ignore lint/suspicious/noExplicitAny: schema is internal Entity property
    const cloned = new Entity((original as any).schema, { client: makeStubClient(), table: 'cloned' });

    expect(cloned.scan).toBeDefined();
  });

  it('does NOT mutate the original entity client when cloning (Pitfall 1 pin)', () => {
    const stubClient1 = makeStubClient();
    const stubClient2 = makeStubClient();
    const original = makeTestEntity(stubClient1, 'original-table');

    // biome-ignore lint/suspicious/noExplicitAny: schema is internal Entity property
    const _cloned = new Entity((original as any).schema, { client: stubClient2, table: 'cloned-table' });

    // After cloning, the ORIGINAL entity must still target original-table.
    const originalParams = original.get({ id: 'x' }).params();
    expect(originalParams.TableName).toBe('original-table');
  });
});
