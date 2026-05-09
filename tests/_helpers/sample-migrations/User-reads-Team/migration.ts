/**
 * Sample migration: User v1 → v2 (denormalizes teamName via cross-entity read).
 *
 * This fixture exists to test Phase 6 cross-entity reads (CTX-01..06). The
 * migration declares `reads: [createTeamEntityReadsTeam(client, table)]` so
 * the runner will build a ctx with a read-only Team facade. The `up()` function
 * uses `ctx.entity(Team).get({id: user.teamId}).go()` to fetch the Team record
 * and denormalize `teamLabel` onto the migrated User record.
 *
 * This is the canonical fixture for:
 *   - CTX-01: ctx is passed as the second argument to up()
 *   - CTX-02: ctx.entity(Team) returns a facade bound to the unguarded client
 *   - CTX-05: eager fingerprint pre-flight on declared reads targets
 *   - CTX-06: reads persisted on _migrations row
 *
 * Migration id: '20260601000005-User-reads-Team' (unique across all fixtures).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1ReadsTeam } from './v1.js';
import { createUserV2ReadsTeam } from './v2.js';
import { createTeamEntityReadsTeam } from './team.js';

/**
 * Factory that creates the User v1→v2 migration (ReadsTeam variant) bound to a
 * specific DynamoDB table and DocumentClient instance.
 *
 * The migration declares `reads: [Team]` so the runner performs eager fingerprint
 * pre-flight before any v2 writes. The `up()` calls `ctx.entity(Team)` to fetch
 * the related Team record and denormalize `teamLabel` as `teamName` onto the User.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name (shared with Team entity).
 * @returns A `Migration<UserV1ReadsTeam, UserV2ReadsTeam>` object with `up` and `down`.
 */
export const createUserReadsTeamMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000005-User-reads-Team',
    entityName: 'User',
    from: createUserV1ReadsTeam(client, table),
    to: createUserV2ReadsTeam(client, table),
    reads: [createTeamEntityReadsTeam(client, table)],
    up: async (record, ctx) => {
      const user = record as { id: string; name: string; teamId: string };
      // biome-ignore lint/suspicious/noExplicitAny: ctx typed as unknown until Plan 06-03 tightens; fixture must work today AND after.
      const ctxApi = ctx as { entity: (e: any) => any } | undefined;
      let teamName = 'unknown';
      if (ctxApi !== undefined) {
        const teamRes = await ctxApi.entity(createTeamEntityReadsTeam(client, table)).get({ id: user.teamId }).go();
        teamName = teamRes?.data?.teamLabel ?? 'unknown';
      }
      return { ...user, teamName };
    },
    down: async (record) => {
      // Strip the denormalized teamName for the v1 shape.
      const { teamName: _t, version: _v, ...v1 } = record as Record<string, unknown>;
      return v1;
    },
  });
