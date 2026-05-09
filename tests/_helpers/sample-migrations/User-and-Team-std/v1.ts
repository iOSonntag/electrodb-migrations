/**
 * Sample frozen v1 User entity for single-table-design (STD) integration tests.
 *
 * This entity shares the same table as the Team entity (see team.ts) — both use
 * `model.service: 'app'` and the same pk/sk field names. The key point of this
 * fixture is that the identity stamp markers `__edb_e__: 'User'` and
 * `__edb_e__: 'Team'` are what distinguish the entities (RESEARCH §Section 3 —
 * "each entity.scan call only returns records whose (__edb_e__, __edb_v__) match
 * THAT entity").
 *
 * Used by Phase 5 RBK-11 STD safety integration test to prove that rolling back
 * the User migration does NOT touch Team records that share the same table.
 *
 * Factory name uses the `Std` suffix to avoid colliding with the `createUserV1`
 * export from the `User-add-status` family of fixtures.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v1 User entity (STD variant) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v1 (STD variant, shares table with Team).
 */
export const createUserV1Std = (client: DynamoDBDocumentClient, table: string) =>
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
