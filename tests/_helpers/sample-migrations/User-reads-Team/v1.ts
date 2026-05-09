/**
 * Sample frozen v1 User entity for Phase 6 cross-entity reads tests.
 *
 * This entity represents a User in version 1, which has a `teamId` foreign
 * key pointing to a Team entity. The migration up() path will read the Team
 * entity via ctx.entity(Team) to denormalize `teamName` onto the User record.
 *
 * Factory name uses the `ReadsTeam` suffix to avoid collisions when multiple
 * fixtures are imported in the same test file.
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name.
 * @returns Bound ElectroDB Entity for User v1 (ReadsTeam variant).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

export const createUserV1ReadsTeam = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'User',
        version: '1',
        service: 'app',
      },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
        teamId: { type: 'string', required: true },
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
