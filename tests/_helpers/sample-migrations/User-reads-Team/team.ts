/**
 * Team entity for Phase 6 cross-entity reads tests (User-reads-Team fixture).
 *
 * This entity deliberately co-locates with the User entity in the SAME DynamoDB
 * table (same `model.service: 'app'`, same pk/sk field names). The User migration
 * declares `reads: [createTeamEntityReadsTeam(client, table)]` and uses
 * `ctx.entity(Team).get({id: teamId})` inside `up()` to denormalize the team
 * name onto the migrated User record.
 *
 * The DELIBERATELY DIFFERENT attribute name `teamLabel` (vs. User's `name`)
 * matches the `User-and-Team-std` fixture convention for cross-contamination
 * detection — code paths that read Team records must see `teamLabel`, never
 * User's `name`.
 *
 * Factory name uses the `ReadsTeam` suffix to avoid collisions when multiple
 * fixtures are imported in the same test file.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name (same as User entities in this fixture).
 * @returns Bound ElectroDB Entity for Team (shares table with User entities).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

export const createTeamEntityReadsTeam = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'Team',
        version: '1',
        service: 'app',
      },
      attributes: {
        id: { type: 'string', required: true },
        /** Deliberately distinct from User's `name` attribute — matches User-and-Team-std convention. */
        teamLabel: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client, table },
  );
