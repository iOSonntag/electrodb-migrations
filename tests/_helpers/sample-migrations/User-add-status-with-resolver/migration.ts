/**
 * Sample migration: User v1 → v2 (adds status='active') — fixture with both a
 * `down()` function AND a `rollbackResolver` for custom-strategy rollback tests.
 *
 * This fixture is used by Phase 5 `custom` rollback strategy tests (README §2.2.4).
 * The `rollbackResolver` demonstrates the canonical "delegate to down for type B
 * records, keep v1Original for type A and C records" pattern per OQ7 / RESEARCH §12.
 *
 * Having both `down()` and `rollbackResolver` is intentional — resolver tests
 * sometimes need `down()` available (e.g., the resolver delegates to `down(v2)` for
 * type B records — so include both). The resolver takes precedence over `down()` when
 * the caller explicitly invokes custom strategy.
 *
 * Fixture migration id: '20260601000002-User-add-status-with-resolver'.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1 } from './v1.js';
import { createUserV2 } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration (with both down and rollbackResolver)
 * bound to a specific DynamoDB table and DocumentClient instance.
 *
 * Both `from` (UserV1) and `to` (UserV2) use the SAME client+table.
 *
 * The `rollbackResolver` receives `{kind, v1Original?, v2?, down}` per record and
 * implements the canonical pattern:
 * - Type A (both v1+v2 present): restore v1Original.
 * - Type B (v2-only, fresh): delegate to down(v2).
 * - Type C (v1-only, already deleted): restore v1Original.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV1, UserV2>` object with `up`, `down`, and `rollbackResolver`.
 */
export const createUserAddStatusWithResolverMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000002-User-add-status-with-resolver',
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
    rollbackResolver: async (args: unknown) => {
      // OQ7 resolver shape: {kind, v1Original?, v2?, down}
      // Canonical "delegate to down for B, keep v1Original for A and C" pattern.
      const a = args as {
        kind: 'A' | 'B' | 'C';
        v1Original?: Record<string, unknown>;
        v2?: Record<string, unknown>;
        down?: (v2: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      if (a.kind === 'A') return a.v1Original ?? null;
      if (a.kind === 'B') {
        if (!a.down || !a.v2) return null;
        return await a.down(a.v2);
      }
      // a.kind === 'C' — v1-only records; restore the original v1 shape.
      return a.v1Original ?? null;
    },
  });
