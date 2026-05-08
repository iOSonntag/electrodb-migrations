import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import { DEFAULT_TABLE_KEYS, type InternalEntityOptions } from './types.js';

/**
 * `_migration_runs`: durable record of one lock cycle on one migration —
 * a single invocation of the runner against a single migration via `apply`,
 * `rollback`, or `finalize`. Aligned with the per-migration lock model:
 * each Lambda invocation (or local in-process run) gets exactly one row.
 *
 * The CLI's `apply` command — which conceptually "runs all pending" — is
 * implemented as a CLI-tier loop that issues N runs against N migrations,
 * not as a single run that touches multiple migrations. The wire contract
 * therefore always carries a `migrationId`; "apply all" never crosses the
 * wire.
 *
 * The lock row in `_migration_state` only carries the *live* run; once
 * that clears, this table is what backs `getRunStatus(runId)` after
 * completion and the `--remote` status polling described in the README.
 *
 * `elapsedMs` is intentionally not stored. Compute it at read time as
 * `(completedAt ?? now) - startedAt`. Storing it would be a stale lie.
 */
export const createMigrationRunsEntity = (client: DynamoDBDocumentClient, table: string, options?: InternalEntityOptions) => {
  const pkField = options?.keyFields?.pk ?? DEFAULT_TABLE_KEYS.pk;
  const skField = options?.keyFields?.sk ?? DEFAULT_TABLE_KEYS.sk;

  return new Entity(
    {
      model: {
        entity: '_migration_runs',
        version: '1',
        service: '_electrodb_migrations',
      },
      attributes: {
        runId: { type: 'string', required: true },
        schemaVersion: { type: 'number', required: true },
        command: {
          type: ['apply', 'rollback', 'finalize'] as const,
          required: true,
        },
        status: {
          type: ['running', 'completed', 'failed'] as const,
          required: true,
        },
        migrationId: { type: 'string', required: true },
        startedAt: { type: 'string', required: true },
        completedAt: { type: 'string' },
        startedBy: { type: 'string' },
        error: {
          type: 'map',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'string' },
          },
        },
        // Phase 3 delta (ENT-04):
        /**
         * Last heartbeat timestamp written by the runner during this run. Updated on every state
         * transition (acquire, transition-to-release, mark-failed) and on final completion. Phase 9's
         * `getRunStatus(runId)` reads this single row after the run completes — eliminating the
         * cross-row read that would otherwise be required to surface heartbeat freshness on the run
         * record. (ARCHITECTURE.md §11.)
         */
        lastHeartbeatAt: { type: 'string' },
      },
      indexes: {
        byRunId: {
          pk: { field: pkField, composite: ['runId'] },
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

/** ElectroDB entity instance returned by {@link createMigrationRunsEntity}. */
export type MigrationRunsEntity = ReturnType<typeof createMigrationRunsEntity>;

/** Schema version stamped onto each `_migration_runs` row at write time. */
export const MIGRATION_RUNS_SCHEMA_VERSION = 1;
