/**
 * Sample frozen v1 entity for the User-add-tier migration fixture.
 *
 * This is "User v2" in the overall User entity lifecycle — the starting point
 * for the User v2 → v3 (add-tier) migration. Equivalent to the v2 entity from
 * User-add-status (same attributes: id, name, status, version).
 *
 * Used by Plan 04-04 tests to verify sequence ordering: two User migrations
 * in the same pending list must be ordered by fromVersion ascending
 * (User-add-status fromVersion='1', User-add-tier fromVersion='2').
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v1 entity for the User-add-tier migration.
 * This represents User at version '2' (the starting point before adding tier).
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v2 (add-tier's "from" entity).
 */
export const createUserV2 = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'User',
        version: '2',
        service: 'app',
      },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        status: { type: ['active', 'inactive'] as const, required: true },
        version: { type: 'string', required: true, default: 'v2', readOnly: true, hidden: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: ['version'] },
        },
      },
    },
    { client, table },
  );
