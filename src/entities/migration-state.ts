import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import { DEFAULT_TABLE_KEYS, type InternalEntityOptions } from '../types.js';

/**
 * `_migration_state`: single aggregate row that the guard reads with one `GetItem`.
 *
 * Encodes:
 * - **Runner mutex** (`lockRunId` / `lockHolder` / `heartbeatAt` / ...) —
 *   transient, present only while a run is active.
 * - **`inFlightIds`** — migrations currently being applied/finalized/rolled
 *   back. Cardinality 0–1 today (global mutex); set type leaves room for
 *   per-migration parallelism without a schema change.
 * - **`failedIds`** — migrations whose latest lifecycle attempt is `failed`.
 *   Non-empty `failedIds` is the gate for `EDBRequiresRollbackError`.
 * - **`releaseIds`** — migrations whose `apply` / `rollback` succeeded but
 *   whose lock has not been cleared by the operator's `release` call yet.
 *   Holds the guard on so app traffic can't write before the new code is
 *   deployed.
 *
 * **Lock state.** `lockState` is required and always set; a missing value is
 * possible only before the row has been bootstrapped (fresh install). It is
 * a single enum capturing every shape the lock can take:
 * - `free` — no lock held. Steady-state idle value; readers and DDB
 *   filter expressions match `lockState = 'free'` rather than testing for
 *   attribute absence.
 * - `apply` | `finalize` | `rollback` — a runner is actively working.
 *   Heartbeat is being maintained on `heartbeatAt`; stale heartbeat under
 *   one of these three states triggers stale-takeover.
 * - `release` — the run succeeded but the operator hasn't yet called
 *   `release`. No active runner; the lock holds the guard on so app traffic
 *   stays gated until the new code is deployed.
 * - `failed` — the most recent run aborted. No active runner; partial v2
 *   writes may remain on disk; app traffic stays gated until the operator
 *   runs `rollback` to clean up. Distinct from a stale `apply` state —
 *   `failed` is **not** subject to stale-takeover.
 *
 * Liveness during an active run is signaled by `heartbeatAt` freshness —
 * there is no separate phase enum, and per-record progress is intentionally
 * not tracked (would contend with the heartbeat on this same hot row).
 *
 * `heartbeatAt` is ISO-8601 so DDB conditional `lt(heartbeatAt, cutoff)`
 * works for stale-lock takeover without numeric coercion.
 *
 * Sets (not lists) for the three id collections: DDB's `SS` type supports
 * value-based add/delete inside transactions; lists only support
 * remove-by-index.
 */
export const createMigrationStateEntity = (client: DynamoDBDocumentClient, table: string, options?: InternalEntityOptions) => {
  const pkField = options?.keyFields?.pk ?? DEFAULT_TABLE_KEYS.pk;
  const skField = options?.keyFields?.sk ?? DEFAULT_TABLE_KEYS.sk;

  return new Entity(
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
        releaseIds: { type: 'set', items: 'string' },
        lockHolder: { type: 'string' },
        lockRunId: { type: 'string' },
        lockAcquiredAt: { type: 'string' },
        lockState: {
          type: ['free', 'apply', 'finalize', 'rollback', 'release', 'failed'] as const,
          required: true,
        },
        lockMigrationId: { type: 'string' },
        heartbeatAt: { type: 'string' },
      },
      indexes: {
        byId: {
          pk: { field: pkField, composite: ['id'] },
          sk: { field: skField, composite: [] },
        },
      },
    },
    {
      client,
      table,
      ...(options?.identifiers ? { identifiers: options.identifiers } : {}),
    },
  );
};

/** ElectroDB entity instance returned by {@link createMigrationStateEntity}. */
export type MigrationStateEntity = ReturnType<typeof createMigrationStateEntity>;

/**
 * Sentinel id for the single aggregate row. ElectroDB requires a partition
 * key value, so we use a fixed string the state-mutations module always reads.
 */
export const MIGRATION_STATE_ID = 'state';

/** Schema version stamped onto the `_migration_state` row at write time. */
export const STATE_SCHEMA_VERSION = 1;
