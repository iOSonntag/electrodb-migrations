import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import type { IdentifiersConfig } from '../types.js';

// _migrations: durable, write-once-then-update audit row per migration.
// Status transitions: pending → applied → finalized (or → failed; → reverted).
//
// Lives in the user's table by default; identifiers default to ElectroDB's
// __edb_e__ / __edb_v__ but can be overridden when the user has customized
// them on their own entities (see EntityConfiguration in electrodb).
export const createMigrationsEntity = (
  client: DynamoDBDocumentClient,
  table: string,
  identifiers?: IdentifiersConfig,
) =>
  new Entity(
    {
      model: {
        entity: '_migrations',
        version: '1',
        service: '_electrodb_migrations',
      },
      attributes: {
        id: { type: 'string', required: true },
        status: {
          type: ['pending', 'applied', 'finalized', 'failed', 'reverted'] as const,
          required: true,
        },
        appliedAt: { type: 'string' },
        finalizedAt: { type: 'string' },
        revertedAt: { type: 'string' },
        appliedBy: { type: 'string' },
        fromVersion: { type: 'string', required: true },
        toVersion: { type: 'string', required: true },
        entityName: { type: 'string', required: true },
        fingerprint: { type: 'string', required: true },
        itemCounts: {
          type: 'map',
          properties: {
            scanned: { type: 'number' },
            migrated: { type: 'number' },
            skipped: { type: 'number' },
            failed: { type: 'number' },
          },
        },
        error: { type: 'string' },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    {
      client,
      table,
      ...(identifiers ? { identifiers } : {}),
    },
  );

export type MigrationsEntity = ReturnType<typeof createMigrationsEntity>;
