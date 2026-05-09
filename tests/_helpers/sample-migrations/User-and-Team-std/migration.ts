/**
 * Sample migration: User v1 → v2 (adds status='active') — STD variant for
 * single-table-design safety tests.
 *
 * This fixture exists specifically to prove that rolling back the User migration
 * MUST NOT touch any Team records that share the table (RBK-11 STD safety +
 * RESEARCH §Pitfall 2). The migration target is `entityName: 'User'` — Team
 * records are SIBLINGS that must be invisible to rollback's v2 scan.
 *
 * The identity-stamp filtering (`__edb_e__: 'User'` vs `__edb_e__: 'Team'`) is
 * what enforces this isolation — each entity's scan call returns only records
 * whose (__edb_e__, __edb_v__) match THAT entity (verified by Phase 4 spike).
 *
 * Fixture migration id: '20260601000004-User-add-status-std'.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1Std } from './v1.js';
import { createUserV2Std } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration (STD variant) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * The migration targets `entityName: 'User'` only. Team records that share the
 * same table must be unaffected by both apply and rollback (RBK-11).
 *
 * Includes `down()` (same as with-down fixture) so STD rollback integration
 * tests can exercise the full rollback flow — the point being to verify Team
 * records are NOT touched by the User-scoped rollback.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name (shared with Team entity).
 * @returns A `Migration<UserV1Std, UserV2Std>` object with `up` and `down`.
 */
export const createUserAddStatusStdMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000004-User-add-status-std',
    entityName: 'User',
    from: createUserV1Std(client, table),
    to: createUserV2Std(client, table),
    up: async (record) => ({
      ...(record as Record<string, unknown>),
      status: 'active',
    }),
    down: async (record) => {
      // Strip `status` and the v2-specific `version` constant attribute to
      // produce a clean v1 shape. Same logic as User-add-status-with-down.
      const { status: _status, version: _version, ...v1 } = record as Record<string, unknown>;
      return v1;
    },
  });
