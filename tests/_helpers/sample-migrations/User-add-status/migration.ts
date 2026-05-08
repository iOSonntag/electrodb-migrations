/**
 * Sample migration: User v1 → v2 (adds status='active').
 *
 * Used by Phase 4 runner unit + integration tests. The transform is intentionally
 * pure + synchronous-equivalent so test failures pinpoint runner orchestration,
 * not user-`up` logic.
 *
 * v2's distinct SK shape (see v2.ts JSDoc + README.md) means writes from this
 * migration COEXIST with the v1 originals — the central B-01 invariant for
 * ROADMAP SC1. The runner pipes scanned v1 records through `up()` then writes
 * them via `to.put(...)` which lands at the v2 SK byte path (different from v1's).
 * v1 rows remain untouched until finalize deletes them.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1 } from './v1.js';
import { createUserV2 } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration bound to a specific
 * DynamoDB table and DocumentClient instance.
 *
 * Both `from` (UserV1) and `to` (UserV2) use the SAME client+table.
 * The runner scans v1 rows via `from.scan`, transforms via `up()`,
 * and writes via `to.put(...)` — landing at the v2 SK path.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV1, UserV2>` object (plain data, no side effects).
 */
export const createUserAddStatusMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000000-User-add-status',
    entityName: 'User',
    from: createUserV1(client, table),
    to: createUserV2(client, table),
    up: async (record) => ({
      ...(record as Record<string, unknown>),
      status: 'active',
    }),
  });
