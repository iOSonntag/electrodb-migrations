/**
 * Sample frozen v2 User entity (ReadsTeam variant).
 *
 * Adds `teamName` (denormalized from Team entity via ctx.entity(Team)) AND a
 * `version: 'v2'` constant attribute that participates in the SK composite.
 *
 * Same B-01 key-shape differentiator as the other v2 fixtures: v1 and v2 produce
 * PHYSICALLY DISTINCT rows so post-apply both v1.scan and v2.scan return only their
 * own records (ROADMAP B-01 / Success Criterion #1).
 *
 * Specifically:
 *   - v1 SK = "$app_1#user_1"            (no version token in composite)
 *   - v2 SK = "$app_2#user_2#version_v2" (version='v2' token present)
 *
 * Factory name uses the `ReadsTeam` suffix to avoid collisions when multiple
 * fixtures are imported in the same test file.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v2 (ReadsTeam variant, includes teamName).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

export const createUserV2ReadsTeam = (client: DynamoDBDocumentClient, table: string) =>
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
        teamId: { type: 'string', required: true },
        teamName: { type: 'string', required: true },
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
