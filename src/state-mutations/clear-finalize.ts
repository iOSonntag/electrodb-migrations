import { EDBMigrationLockHeldError } from '../errors/index.js';
import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';
import { isConditionalCheckFailed } from './cancellation.js';

/** Inputs for {@link clearFinalizeMode}. */
export interface ClearFinalizeModeArgs {
  /** The runId that holds the finalize-mode lock. */
  runId: string;
}

/**
 * Clear the finalize-mode lock — single patch that flips
 * `lockState='free'` and removes the lock-holder fields.
 *
 * FIN-03: the counterpart to {@link clear} for the finalize path.
 * `clear()` requires `lockState='release'` (the apply/rollback handoff path).
 * `clearFinalizeMode()` requires `lockState='finalize'` with the same `runId`
 * guard — the finalize orchestrator is the only caller.
 *
 * **ConditionExpression:**
 *   lockRunId = :runId AND lockState = 'finalize'
 *
 * The `lockState='finalize'` filter prevents clearing a concurrently
 * re-acquired lock. The `lockRunId = :runId` pin ensures only the runner
 * that acquired the finalize lock can release it (defends Pitfall #5).
 *
 * **No TransactWrite needed.** Finalize's post-loop does not need to update
 * `_migration_runs` here (the `migrations.patch` that precedes this call is
 * a separate, non-transactional write). This mirrors `clear()`'s single-item
 * transact design for simplicity; `_migration_runs` is updated separately.
 */
export async function clearFinalizeMode(service: MigrationsServiceBundle, args: ClearFinalizeModeArgs): Promise<void> {
  const now = new Date().toISOString();

  await service.migrationState
    .patch({ id: MIGRATION_STATE_ID })
    .set({ lockState: 'free', updatedAt: now })
    .remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt', 'releaseIds', 'inFlightIds'])
    .where(({ lockRunId, lockState }, op) => `${op.eq(lockRunId, args.runId)} AND ${op.eq(lockState, 'finalize')}`)
    .go()
    .catch((err: unknown) => {
      // Translate a ConditionalCheckFailed into the same EDBMigrationLockHeldError
      // shape that `clear` uses so callers get consistent error types. Use the
      // canonical helper from ./cancellation.js rather than substring-matching
      // the AWS SDK error message, which can drift across SDK versions.
      if (isConditionalCheckFailed(err)) {
        throw new EDBMigrationLockHeldError('clearFinalizeMode refused — lock no longer held by this runner or not in finalize state', {});
      }
      throw err;
    });
}
