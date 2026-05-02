import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import type { IdentifiersConfig } from '../types.js';

// _migration_state: single aggregate row that the guard reads with one GetItem.
//
// Encodes:
//   • Runner mutex (lockRefId / heartbeatAt / ...) — transient, optional.
//   • inFlightIds — migrations currently being applied/finalized/rolled back.
//     Cardinality 0–1 today (global mutex); set type leaves room for per-migration
//     parallelism without a schema change.
//   • failedIds — migrations whose latest lifecycle attempt is `failed`.
//   • deploymentBlockedIds — migrations holding the guard on after a successful
//     apply/rollback with autoRelease=false. Cleared by releaseDeploymentBlock.
//
// heartbeatAt is ISO-8601 so DDB conditional `lt(heartbeatAt, cutoff)` works
// for stale-lock takeover without numeric coercion.
//
// Sets (not lists) for the three id collections: DDB's SS type supports
// value-based add/delete inside transactions; lists only support remove-by-index.
export const createMigrationStateEntity = (
  client: DynamoDBDocumentClient,
  table: string,
  identifiers?: IdentifiersConfig,
) =>
  new Entity(
    {
      model: {
        entity: '_migration_state',
        version: '1',
        service: '_electrodb_migrations',
      },
      attributes: {
        id: { type: 'string', required: true },
        schemaVersion: { type: 'number', required: true },
        updatedAt: { type: 'string', required: true },
        inFlightIds: { type: 'set', items: 'string' },
        failedIds: { type: 'set', items: 'string' },
        deploymentBlockedIds: { type: 'set', items: 'string' },
        lockHolder: { type: 'string' },
        lockRefId: { type: 'string' },
        lockAcquiredAt: { type: 'string' },
        lockOperation: {
          type: ['apply', 'finalize', 'rollback'] as const,
        },
        lockMigrationId: { type: 'string' },
        heartbeatAt: { type: 'string' },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    {
      client,
      table,
      ...(identifiers ? { identifiers } : {}),
    },
  );

export type MigrationStateEntity = ReturnType<typeof createMigrationStateEntity>;

// Sentinel id for the single aggregate row. ElectroDB requires a partition
// key value, so we use a fixed string the state-mutations module always reads.
export const MIGRATION_STATE_ID = 'state';

export const STATE_SCHEMA_VERSION = 1;
