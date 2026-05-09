/**
 * Sample frozen v2 entity. Adds required `status` attribute AND a `version: 'v2'`
 * constant attribute that participates in the SK composite.
 *
 * This is the deliberate B-01 fix: v1 and v2 produce PHYSICALLY DISTINCT rows so
 * post-apply both v1.scan and v2.scan return 1,000 records each (ROADMAP Success
 * Criterion #1). See README.md in the User-add-status directory for the full rationale.
 *
 * Specifically:
 *   - v1 SK = "$app_1#user_1"            (no version token in composite)
 *   - v2 SK = "$app_2#user_2#version_v2" (version='v2' token present)
 *
 * Because (pk, sk) byte sequences differ, writing a v2 record via
 * `migration.to.put(...)` does NOT overwrite the v1 row. The `__edb_e__`/`__edb_v__`
 * identity stamps also differ (version: '1' vs. '2'), so `v1.scan` filters out v2
 * rows and `v2.scan` filters out v1 rows — both required for SC1.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the frozen v2 User entity bound to a specific
 * DynamoDB table and DocumentClient instance.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v2 (includes `status` + `version` attributes).
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
        /**
         * Constant attribute that participates in the SK composite.
         * This is the B-01 key-shape differentiator: every v2 row gets a
         * `version_v2` token baked into its SK, making v2 rows physically
         * distinct from v1 rows even when they share the same `id`.
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
