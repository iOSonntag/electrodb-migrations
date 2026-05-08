import { EDBMigrationLockHeldError } from '../errors/index.js';
import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';
import { type TransactionWriteResult, extractResultCancellationReason, isResultConditionalCheckFailed } from './cancellation.js';

/** Inputs for {@link clear}. */
export interface ClearArgs {
  /** The runId that previously transitioned this lock into release-mode. */
  runId: string;
}

/**
 * Clear the release-mode lock — single 1-item transactWrite that flips
 * `lockState='free'` and removes the lock-holder fields.
 *
 * **Item 0 — `_migration_state` patch:**
 * - `set({lockState: 'free', updatedAt})`
 * - `remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt'])`
 *
 * **ConditionExpression** (LCK-09):
 *
 *   lockState = 'release' AND lockRunId = :runId AND attribute_not_exists(inFlightIds)
 *
 * **`attribute_not_exists(inFlightIds)` is the DDB-equivalent of `size(inFlightIds) = 0`.**
 * DynamoDB's set-type semantics: when the last element is removed via
 * `delete({inFlightIds: [...]})`, DDB removes the attribute entirely (empty
 * sets cannot be stored). So `attribute_not_exists(inFlightIds)` and
 * `size(inFlightIds) = 0` are equivalent — the former is what the
 * ElectroDB-native `op.notExists` produces, while the latter would require
 * either a raw UpdateCommand or a ConditionExpression-string fallback that
 * does not compose cleanly with ElectroDB's `op.size`. We pick the
 * functionally-equivalent native form.
 *
 * **No try/catch.** On `ConditionalCheckFailedException`, ElectroDB throws
 * directly. The CLI command (Phase 4 REL-02) wraps the throw with the
 * friendly "no active release-mode lock" message.
 */
export async function clear(service: MigrationsServiceBundle, args: ClearArgs): Promise<void> {
  const now = new Date().toISOString();

  const result = (await service.service.transaction
    .write(({ migrationState }) => [
      migrationState
        .patch({ id: MIGRATION_STATE_ID })
        .set({ lockState: 'free', updatedAt: now })
        // CR-02 fix: also drop releaseIds — the set is per-cycle bookkeeping
        // (which migrations went through release-mode this batch) and the
        // batch is over once the lock returns to 'free'. Without this remove,
        // releaseIds grows unbounded across migration cycles and Phase 4's
        // `status` command would surface phantom "pending release" entries.
        .remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt', 'releaseIds'])
        .where(({ lockState, lockRunId, inFlightIds }, op) => `${op.eq(lockState, 'release')} AND ${op.eq(lockRunId, args.runId)} AND ${op.notExists(inFlightIds)}`)
        .commit(),
    ])
    .go()) as TransactionWriteResult;

  if (isResultConditionalCheckFailed(result)) {
    const reason = extractResultCancellationReason(result);
    throw new EDBMigrationLockHeldError('clear refused — release-mode lock conditions not met (lockState!=release, runId mismatch, or inFlightIds non-empty)', {
      currentLockState: reason?.item?.lockState,
      currentLockHolder: reason?.item?.lockHolder,
      currentRunId: reason?.item?.lockRunId,
      currentLockMigrationId: reason?.item?.lockMigrationId,
    });
  }
}
