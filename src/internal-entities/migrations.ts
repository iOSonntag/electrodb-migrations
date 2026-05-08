import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import { DEFAULT_TABLE_KEYS, type InternalEntityOptions } from './types.js';

/**
 * `_migrations`: durable, write-once-then-update audit row per migration.
 *
 * Status transitions: `pending` → `applied` → `finalized` (or → `failed`;
 * → `reverted`).
 *
 * `fromVersion` / `toVersion` are decimal-integer strings (no leading zeros)
 * to mirror ElectroDB's `model.version` shape while still supporting the
 * "increment by 1" rule the validate gate enforces. Format is checked at
 * write time by the migration runner — not at the schema layer, since
 * ElectroDB has no numeric-string constraint.
 *
 * `runId` references (`appliedRunId` / `revertedRunId`) link each terminal
 * state to the run record in `_migration_runs` that produced it, so audit
 * and run history stitch together.
 *
 * `kind` is `'transform'` for v0.1. Reserved as an enum so v0.2's
 * entity-deletion migrations can land without a schema bump on the audit row.
 *
 * Indexed only by `id`. Audit-table cardinality is small (one row per
 * migration ever performed on a project), so per-entity / per-status lookups
 * use `Scan` with `FilterExpression` rather than requiring the user's table
 * to provision GSIs the framework's internal entities would otherwise need.
 *
 * Lives in the user's table by default. `identifiers` are forwarded to
 * ElectroDB only when the user explicitly supplied
 * `keyNames.electroEntity` / `keyNames.electroVersion`; otherwise the
 * factory passes no `identifiers` option and ElectroDB uses whatever its
 * own defaults are (see `EntityConfiguration` in electrodb).
 */
export const createMigrationsEntity = (client: DynamoDBDocumentClient, table: string, options?: InternalEntityOptions) => {
  const pkField = options?.keyFields?.pk ?? DEFAULT_TABLE_KEYS.pk;
  const skField = options?.keyFields?.sk ?? DEFAULT_TABLE_KEYS.sk;

  return new Entity(
    {
      model: {
        entity: '_migrations',
        version: '1',
        service: '_electrodb_migrations',
      },
      attributes: {
        id: { type: 'string', required: true },
        schemaVersion: { type: 'number', required: true },
        kind: { type: ['transform'] as const, required: true },
        status: {
          type: ['pending', 'applied', 'finalized', 'failed', 'reverted'] as const,
          required: true,
        },
        appliedAt: { type: 'string' },
        finalizedAt: { type: 'string' },
        revertedAt: { type: 'string' },
        appliedBy: { type: 'string' },
        appliedRunId: { type: 'string' },
        revertedRunId: { type: 'string' },
        fromVersion: { type: 'string', required: true },
        toVersion: { type: 'string', required: true },
        entityName: { type: 'string', required: true },
        fingerprint: { type: 'string', required: true },
        itemCounts: {
          type: 'map',
          properties: {
            scanned: { type: 'number' },
            migrated: { type: 'number' },
            skipped: { type: 'number' },
            failed: { type: 'number' },
          },
        },
        error: {
          type: 'map',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: { type: 'string' },
          },
        },
        // Phase 3 deltas (ENT-03, CTX-06):
        reads: { type: 'set', items: 'string' },
        rollbackStrategy: {
          type: ['projected', 'snapshot', 'fill-only', 'custom'] as const,
        },
        hasDown: { type: 'boolean' },
        hasRollbackResolver: { type: 'boolean' },
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

/** ElectroDB entity instance returned by {@link createMigrationsEntity}. */
export type MigrationsEntity = ReturnType<typeof createMigrationsEntity>;

/** Schema version stamped onto each `_migrations` row at write time. */
export const MIGRATIONS_SCHEMA_VERSION = 1;
