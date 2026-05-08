/**
 * Sample migration: User v2 → v3 (adds tier='free').
 *
 * Used by Plan 04-04 tests to verify sequence ordering: this migration has
 * fromVersion='2', which must sort AFTER User-add-status (fromVersion='1')
 * in the per-entity sorted pending list (RUN-06 sequence enforcement).
 *
 * The transform sets tier='free' as the default for all existing users.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV2 } from './v1.js';
import { createUserV3 } from './v2.js';

/**
 * Factory that creates the User v2→v3 migration bound to a specific
 * DynamoDB table and DocumentClient instance.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV2, UserV3>` object (plain data, no side effects).
 */
export const createUserAddTierMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260701000000-User-add-tier',
    entityName: 'User',
    from: createUserV2(client, table),
    to: createUserV3(client, table),
    up: async (record) => ({
      ...(record as Record<string, unknown>),
      tier: 'free',
    }),
  });
