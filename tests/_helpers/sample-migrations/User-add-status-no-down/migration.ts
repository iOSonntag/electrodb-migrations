/**
 * Sample migration: User v1 → v2 (adds status='active') — fixture intentionally
 * WITHOUT a `down()` function or `rollbackResolver`.
 *
 * This fixture is used by Phase 5 refusal tests (RBK-09 / RBK-10). Specifically:
 * - Attempting to rollback this migration with `projected` or `fill-only` strategy
 *   must throw `EDBRollbackNotPossibleError({reason: 'NO_DOWN_FUNCTION'})`.
 * - Attempting to rollback with `custom` strategy must throw
 *   `EDBRollbackNotPossibleError({reason: 'NO_RESOLVER'})`.
 *
 * The ABSENCE of `down` and `rollbackResolver` is intentional and load-bearing.
 * DO NOT add either field to this migration — the fixture only has `up()`.
 *
 * Fixture migration id: '20260601000003-User-add-status-no-down'.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1 } from './v1.js';
import { createUserV2 } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration (up-only, no down) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * This migration intentionally OMITS `down()` and `rollbackResolver` so that
 * RBK-09 and RBK-10 refusal tests can verify the framework correctly refuses
 * rollback when no reverse path is defined.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV1, UserV2>` object with ONLY `up` (no `down`, no `rollbackResolver`).
 */
export const createUserAddStatusNoDownMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000003-User-add-status-no-down',
    entityName: 'User',
    from: createUserV1(client, table),
    to: createUserV2(client, table),
    up: async (record) => ({
      ...(record as Record<string, unknown>),
      status: 'active',
    }),
  });
