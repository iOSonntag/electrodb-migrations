/**
 * Team entity for single-table-design (STD) integration tests.
 *
 * This entity deliberately co-locates with the User entity in the SAME DynamoDB
 * table (same `model.service: 'app'`, same pk/sk field names) to prove that
 * rolling back the User migration does NOT touch Team records (RBK-11 STD safety).
 *
 * The DELIBERATELY DIFFERENT attribute name `teamLabel` (vs. User's `name`) gives
 * integration tests an unambiguous way to assert cross-contamination never occurs:
 * - Scanning User entities must NEVER return records with `teamLabel`.
 * - Scanning Team entities must NEVER return records with `name` (User-specific).
 *
 * Identity-stamp filtering verified by Phase 4 spike:
 * `tests/integration/runner/identity-stamp-scan.spike.test.ts`
 * Each entity's scan call returns only records whose (__edb_e__, __edb_v__)
 * match THAT entity (RESEARCH §Section 3 lines 1110-1111).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

/**
 * Factory that creates the Team entity bound to a specific DynamoDB table
 * and DocumentClient instance.
 *
 * The Team entity lives in the SAME service as User ('app') but has a distinct
 * `model.entity: 'Team'` so ElectroDB writes `__edb_e__: 'Team'` on each row.
 * This is the STD co-location scenario (RESEARCH §Pitfall 2).
 *
 * @param client - DynamoDB DocumentClient (from `@aws-sdk/lib-dynamodb`).
 * @param table  - Target DynamoDB table name (same as User entities in this fixture).
 * @returns Bound ElectroDB Entity for Team (shares table with User entities).
 */
export const createTeamEntity = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: {
        entity: 'Team',
        version: '1',
        service: 'app',
      },
      attributes: {
        id: { type: 'string', required: true },
        /** Deliberately distinct from User's `name` attribute for cross-contamination assertions. */
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
