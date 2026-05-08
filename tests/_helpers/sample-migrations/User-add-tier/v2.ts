/**
 * Sample frozen v2 entity for the User-add-tier migration fixture.
 *
 * This is "User v3" in the overall User entity lifecycle — the result of
 * applying the User v2 → v3 (add-tier) migration. Adds the required `tier`
 * attribute with values 'free' | 'pro'.
 *
 * The SK composite includes a 'v3' version token to distinguish v3 rows from
 * v2 rows in a single-table-design scenario (same B-01 principle as User-add-status).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v2 entity for the User-add-tier migration.
 * This represents User at version '3' (the result of adding tier).
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v3 (add-tier's "to" entity).
 */
export const createUserV3 = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'User',
        version: '3',
        service: 'app',
      },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        status: { type: ['active', 'inactive'] as const, required: true },
        tier: { type: ['free', 'pro'] as const, required: true },
        /**
         * Version token in SK composite — differentiates v3 rows from v2 rows.
         * v3 SK = "$app_3#user_3#version_v3" vs v2 SK = "$app_2#user_2#version_v2".
         */
        version: { type: 'string', required: true, default: 'v3', readOnly: true, hidden: true },
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
