import type { ResolvedConfig } from '../config/index.js';
import { EDBMigrationLockHeldError } from '../errors/index.js';
import {
  MIGRATION_RUNS_SCHEMA_VERSION,
  MIGRATION_STATE_ID,
  type MigrationsServiceBundle,
  STATE_SCHEMA_VERSION,
} from '../internal-entities/index.js';
import { extractCancellationReason, isConditionalCheckFailed } from './cancellation.js';

/**
 * Inputs for the highest-stakes verb in the framework. Every field is
 * required — a partial argument shape is a programmer error in the runner.
 */
export interface AcquireArgs {
  /** The lockState the runner is acquiring. Mirrors the runner's command. */
  mode: 'apply' | 'rollback' | 'finalize';
  /** The migration this acquire is for; pinned to the lock row's `lockMigrationId`. */
  migId: string;
  /** Per-run UUID; used to read-back-verify the acquire and as the heartbeat condition. */
  runId: string;
  /** Operator/host identifier for diagnostic surface (`status` command). */
  holder: string;
}

/**
 * Acquire the global migration lock with the LCK-01 conditional-write
 * ConditionExpression.
 *
 * **Item order (Pitfall #7):**
 * 0. `_migration_state` patch — sets the lock-holder fields, adds `migId`
 *    to `inFlightIds`, and commits with `returnValuesOnConditionCheckFailure:
 *    'ALL_OLD'` so a contention failure surfaces the current holder.
 * 1. `_migration_runs` put — writes the run row with `status: 'running'`.
 *
 * **ConditionExpression on item 0** (LCK-01 + LCK-03):
 *
 * ```
 * attribute_not_exists(lockState)
 * OR lockState = 'free'
 * OR ((lockState = 'apply' OR lockState = 'rollback'
 *      OR lockState = 'finalize' OR lockState = 'dying')
 *     AND heartbeatAt < :staleCutoff)
 * ```
 *
 * `release` and `failed` are intentionally NOT in the takeover allowlist —
 * those require an explicit `unlock` (LCK-08).
 *
 * **Wave 0 fallback note (Decision A1/A2).** ElectroDB's `op.contains(list, attr)`
 * signature for an IN-clause does not exist (`contains(name, value)` is set/string
 * containment, the opposite direction). The `IN ('apply','rollback','finalize','dying')`
 * filter is therefore composed as a four-way OR. Equivalent ConditionExpression;
 * no functional difference.
 *
 * **Error translation.** On `TransactionCanceledException` whose item-0 reason
 * is `ConditionalCheckFailed`, throws {@link EDBMigrationLockHeldError} carrying
 * any current-holder details from `CancellationReasons[0].Item` (DDB Local may
 * omit ALL_OLD; details are then empty). All other errors are rethrown verbatim.
 */
export async function acquire(
  service: MigrationsServiceBundle,
  config: ResolvedConfig,
  args: AcquireArgs,
): Promise<void> {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - config.lock.staleThresholdMs).toISOString();

  try {
    await service.service.transaction
      .write(({ migrationState, migrationRuns }) => [
        // Item 0 — _migration_state (Pitfall #7 ordering)
        migrationState
          .patch({ id: MIGRATION_STATE_ID })
          .set({
            lockState: args.mode,
            lockHolder: args.holder,
            lockRunId: args.runId,
            lockMigrationId: args.migId,
            lockAcquiredAt: now,
            heartbeatAt: now,
            updatedAt: now,
            schemaVersion: STATE_SCHEMA_VERSION,
          })
          .add({ inFlightIds: [args.migId] })
          .where(
            ({ lockState, heartbeatAt }, op) =>
              `${op.notExists(lockState)} OR ${op.eq(lockState, 'free')} OR ((${op.eq(lockState, 'apply')} OR ${op.eq(lockState, 'rollback')} OR ${op.eq(lockState, 'finalize')} OR ${op.eq(lockState, 'dying')}) AND ${op.lt(heartbeatAt, staleCutoff)})`,
          )
          // ElectroDB v3's `response: 'all_old'` is the typed surface for
          // DDB's `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` on
          // transactWrite items (see electrodb/src/entity.js:1747-1750).
          .commit({ response: 'all_old' }),
        // Item 1 — _migration_runs
        migrationRuns
          .put({
            runId: args.runId,
            command: args.mode,
            status: 'running',
            migrationId: args.migId,
            startedAt: now,
            startedBy: args.holder,
            schemaVersion: MIGRATION_RUNS_SCHEMA_VERSION,
          })
          .commit(),
      ])
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      const reason = extractCancellationReason(err);
      const item = reason?.item;
      throw new EDBMigrationLockHeldError('Lock currently held by another runner', {
        currentLockState: item?.lockState,
        currentLockHolder: item?.lockHolder,
        currentRunId: item?.lockRunId,
        currentLockMigrationId: item?.lockMigrationId,
        currentHeartbeatAt: item?.heartbeatAt,
        currentLockAcquiredAt: item?.lockAcquiredAt,
      });
    }
    throw err;
  }
}
