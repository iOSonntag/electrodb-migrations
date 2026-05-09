/**
 * Sample frozen v1 entity for runner integration tests; mirrors the User fixture
 * used by README §4 quick-start (add-status). DO NOT add a `status` attribute
 * here — that addition is what `up()` performs.
 *
 * The empty SK composite means ElectroDB's identity stamp injection differentiates
 * v1 SK from v2 SK at the byte level (verified by Wave 0 spike + apply-happy-path
 * test). v1 rows with `sk = "$app_1#user_1"` are DISTINCT from v2 rows with
 * `sk = "$app_2#user_2#version_v2"` so post-apply both v1.scan and v2.scan return
 * the expected counts (ROADMAP B-01 / Success Criterion #1).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v1 User entity bound to a specific
 * DynamoDB table and DocumentClient instance.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v1.
 */
export const createUserV1 = (client: DynamoDBDocumentClient, table: string) =>
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
