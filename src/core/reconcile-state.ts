import type { MigrationStateEntity } from '../entities/migration-state.js';
import { MIGRATION_STATE_ID } from '../entities/migration-state.js';
import type { MigrationsEntity } from '../entities/migrations.js';
import { ElectroDBMigrationError } from '../errors.js';
import { bootstrapStateRow, isConditionalCheckFailed } from './lock.js';

// Rebuilds the aggregate `_migration_state` row from ground truth in the
// `_migrations` table. Refuses to run while a runner mutex is held — running
// while a migration is in flight would race with the runner's own writes.
//
// What this method DOES rebuild:
//   - failedIds: every migration row with status='failed'.
//   - inFlightIds: cleared (post-condition: no runner is active).
//
// What this method DOES NOT rebuild:
//   - deploymentBlockedIds: this is runner-asserted intent (autoRelease=false
//     on apply/rollback) — it's not derivable from the audit table. Operators
//     who want to clear blocks have releaseAllDeploymentBlocks().
//   - lock fields: cleared earlier by forceUnlock or by the prior runner.
//     Reconcile is the typical follow-up to forceUnlock.
export const reconcileState = async (
  migrations: MigrationsEntity,
  state: MigrationStateEntity,
): Promise<void> => {
  // Ensure the state row exists before attempting to update it.
  await bootstrapStateRow(state);

  const failed = await migrations.scan
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
    .where((attr: any, op: any) => op.eq(attr.status, 'failed'))
    .go({ pages: 'all' });

  const failedIds = failed.data.map((row) => row.id);
  const now = new Date().toISOString();

  // Two-step rebuild: REMOVE the old set values, then (separately) ADD the
  // new ones. DDB's UpdateItem rejects an UpdateExpression that both REMOVEs
  // and ADDs the same path; ElectroDB doesn't paper over that. Atomicity is
  // not critical here — reconcile is operator-driven and already gated by the
  // notExists(lockRefId) condition, so nothing else mutates the row in
  // between.
  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .remove(['failedIds', 'inFlightIds'])
      .set({ updatedAt: now })
      // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
      .where((attr: any, op: any) => op.notExists(attr.lockRefId))
      .go();

    if (failedIds.length > 0) {
      await state
        .update({ id: MIGRATION_STATE_ID })
        .add({ failedIds })
        .set({ updatedAt: new Date().toISOString() })
        // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
        .where((attr: any, op: any) => op.notExists(attr.lockRefId))
        .go();
    }
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ElectroDBMigrationError(
        'Cannot reconcile state while a migration runner is active. Wait for it to finish or call forceUnlock.',
      );
    }
    throw err;
  }
};
