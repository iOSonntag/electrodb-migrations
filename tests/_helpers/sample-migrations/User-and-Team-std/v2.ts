/**
 * Sample frozen v2 User entity (STD variant). Adds required `status` attribute AND
 * a `version: 'v2'` constant attribute that participates in the SK composite.
 *
 * Same B-01 key-shape differentiator as the other v2 fixtures: v1 and v2 produce
 * PHYSICALLY DISTINCT rows so post-apply both v1.scan and v2.scan return only their
 * own records (ROADMAP B-01 / Success Criterion #1).
 *
 * Specifically:
 *   - v1 SK = "$app_1#user_1"            (no version token in composite)
 *   - v2 SK = "$app_2#user_2#version_v2" (version='v2' token present)
 *
 * Used by Phase 5 RBK-11 STD safety integration test.
 * Factory name uses the `Std` suffix to avoid colliding with `createUserV2` exports
 * from the User-add-status family of fixtures.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v2 User entity (STD variant) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v2 STD (includes `status` + `version` attributes).
 */
export const createUserV2Std = (client: DynamoDBDocumentClient, table: string) =>
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
        /**
         * Constant attribute that participates in the SK composite.
         * B-01 key-shape differentiator: every v2 row gets a `version_v2` token
         * baked into its SK, making v2 rows physically distinct from v1 rows.
         */
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
