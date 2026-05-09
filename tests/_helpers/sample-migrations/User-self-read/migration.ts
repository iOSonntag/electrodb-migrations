/**
 * Sample migration: User v1 → v2 (self-read detection fixture).
 *
 * This fixture exists to test Phase 6 CTX-04 self-read detection. The migration
 * does NOT declare any `reads` — instead the up() function calls
 * `ctx.entity(<self>)` at runtime, which MUST throw EDBSelfReadInMigrationError
 * before any DDB call is made.
 *
 * This is the canonical fixture for:
 *   - CTX-04: ctx.entity(SelfEntity) throws EDBSelfReadInMigrationError
 *     at runtime (undeclared self-read case)
 *
 * Migration id: '20260601000006-User-self-read' (unique across all fixtures).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1SelfRead } from './v1.js';
import { createUserV2SelfRead } from './v2.js';

/**
 * Factory that creates the User v1→v2 migration (SelfRead variant) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * The migration has NO `reads` declaration. The up() calls `ctx.entity(self)`
 * to trigger CTX-04 EDBSelfReadInMigrationError. The test harness asserts the
 * throw occurs before any DDB call.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns A `Migration<UserV1SelfRead, UserV2SelfRead>` object.
 */
export const createUserSelfReadMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000006-User-self-read',
    entityName: 'User',
    from: createUserV1SelfRead(client, table),
    to: createUserV2SelfRead(client, table),
    up: async (record, ctx) => {
      const user = record as { id: string };
      // biome-ignore lint/suspicious/noExplicitAny: ctx is `unknown` until Plan 06-03; the test harness asserts the throw.
      const ctxApi = ctx as { entity: (e: any) => any } | undefined;
      if (ctxApi !== undefined) {
        // CTX-04: this MUST throw EDBSelfReadInMigrationError before any DDB call.
        await ctxApi.entity(createUserV1SelfRead(client, table)).get({ id: user.id }).go();
      }
      return { ...user, status: 'active' };
    },
  });
