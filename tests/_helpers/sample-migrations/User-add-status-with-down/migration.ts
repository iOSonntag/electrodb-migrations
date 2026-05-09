/**
 * Sample migration: User v1 → v2 (adds status='active') — canonical "happy path" fixture
 * with a `down()` function for rollback.
 *
 * This is the canonical fixture for `projected`, `fill-only`, and `custom` rollback
 * strategy tests (README §2.2.1 / §2.2.3). The `down()` function strips the `status`
 * field and the v2-specific `version` constant attribute, returning the v1-shaped record.
 *
 * Used by Phase 5 per-strategy and happy-path integration tests. The transform is
 * intentionally pure + synchronous-equivalent so test failures pinpoint rollback
 * orchestration, not user `down()` logic.
 *
 * v2's distinct SK shape (see v2.ts JSDoc + User-add-status/README.md) means writes
 * from this migration COEXIST with the v1 originals — the central B-01 invariant for
 * ROADMAP SC1. Rolling back deletes v2 rows and may restore v1 rows depending on
 * the chosen strategy (projected = delete-v2-only; fill-only = restore-v1).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1 } from './v1.js';
import { createUserV2 } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration (with down function) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * Both `from` (UserV1) and `to` (UserV2) use the SAME client+table.
 * The runner scans v1 rows via `from.scan`, transforms via `up()`,
 * and writes via `to.put(...)` — landing at the v2 SK path. Rollback
 * scans v2 rows via `to.scan`, transforms via `down()`, and writes
 * via `from.put(...)` — restoring the v1 SK path.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV1, UserV2>` object with both `up` and `down` (plain data, no side effects).
 */
export const createUserAddStatusWithDownMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000001-User-add-status-with-down',
    entityName: 'User',
    from: createUserV1(client, table),
    to: createUserV2(client, table),
    up: async (record) => ({
      ...(record as Record<string, unknown>),
      status: 'active',
    }),
    down: async (record) => {
      // Strip the `status` field added by `up()` plus the v2-specific `version`
      // constant attribute. The `version` attribute is hidden in the v2 schema
      // but ElectroDB-parsed v2 records will carry it; we strip it to produce
      // a clean v1 shape that v1's schema will accept.
      const { status: _status, version: _version, ...v1 } = record as Record<string, unknown>;
      return v1;
    },
  });
