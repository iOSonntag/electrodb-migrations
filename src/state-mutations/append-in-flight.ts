import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/** Inputs for {@link appendInFlight}. */
export interface AppendInFlightArgs {
  runId: string;
  migId: string;
}

/**
 * Append `migId` to `_migration_state.inFlightIds` and pin
 * `lockMigrationId = migId`.
 *
 * Used by Phase 4's apply-batch loop when starting the next pending migration
 * after a release-mode handoff: the lock has been re-acquired (still held by
 * the same `runId`), and the runner needs to advance its in-flight pointer.
 *
 * **Item 0 — `_migration_state` patch** (no transactWrite):
 * - `set({lockMigrationId: migId, updatedAt})`
 * - `add({inFlightIds: [migId]})`
 *
 * **ConditionExpression:** `lockRunId = :runId` — defends against an
 * operator unlock racing with the apply-batch loop.
 */
export async function appendInFlight(service: MigrationsServiceBundle, args: AppendInFlightArgs): Promise<void> {
  const now = new Date().toISOString();
  await service.migrationState
    .patch({ id: MIGRATION_STATE_ID })
    .set({ lockMigrationId: args.migId, updatedAt: now })
    .add({ inFlightIds: [args.migId] })
    .where(({ lockRunId }, op) => op.eq(lockRunId, args.runId))
    .go();
}
