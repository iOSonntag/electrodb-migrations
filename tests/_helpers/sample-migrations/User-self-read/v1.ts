/**
 * Sample frozen v1 User entity for Phase 6 self-read detection tests.
 *
 * This entity is used in the User-self-read fixture, whose migration's up()
 * calls `ctx.entity(<self>)` to trigger CTX-04 EDBSelfReadInMigrationError.
 * The fixture has NO `reads` declaration — the self-read happens at runtime
 * via an undeclared ctx.entity() call.
 *
 * Factory name uses the `SelfRead` suffix to avoid collisions when multiple
 * fixtures are imported in the same test file.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v1 (SelfRead variant).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

export const createUserV1SelfRead = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'User',
        version: '1',
        service: 'app',
      },
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
