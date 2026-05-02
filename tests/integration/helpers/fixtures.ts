import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import { defineMigration } from '../../../src/core/define-migration.js';

// Sample User v1: { id, email }. Version "1".
export const createUserV1 = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: { entity: 'User', version: '1', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        email: { type: 'string', required: true },
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

// Sample User v2: { id, email, status }. Version "2".
// Same composite key shape as v1 — records coexist invisibly thanks to ElectroDB's
// __edb_e__ / __edb_v__ identity stamps.
export const createUserV2 = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: { entity: 'User', version: '2', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        email: { type: 'string', required: true },
        status: { type: ['active', 'inactive'] as const, required: true },
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

// Migration: User v1 → v2, adds status='active'. Reversible via down().
export const createUserMigration = (
  client: DynamoDBDocumentClient,
  table: string,
  id = '20260428-add-status',
) => {
  const from = createUserV1(client, table);
  const to = createUserV2(client, table);
  return defineMigration({
    id,
    entityName: 'User',
    from,
    to,
    up: async (item) => ({ ...item, status: 'active' as const }),
    down: async (item) => {
      const { status: _status, ...rest } = item;
      return rest;
    },
  });
};

// Bulk-seed N v1 user records via batch put.
// biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity generic propagation
export const seedV1 = async (entity: any, count: number): Promise<void> => {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `user-${String(i).padStart(4, '0')}`,
    email: `user${i}@example.com`,
  }));
  await entity.put(items).go({ concurrent: 4 });
};
