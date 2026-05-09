import type { ResolvedConfig } from '../config/index.js';
import { EDBMigrationLockHeldError } from '../errors/index.js';
import { MIGRATION_RUNS_SCHEMA_VERSION, MIGRATION_STATE_ID, type MigrationsServiceBundle, STATE_SCHEMA_VERSION } from '../internal-entities/index.js';
import { type TransactionWriteResult, extractCancellationReason, extractResultCancellationReason, isConditionalCheckFailed, isResultConditionalCheckFailed } from './cancellation.js';

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
 * Apply / finalize mode (UNCHANGED):
 * ```
 * attribute_not_exists(lockState)
 * OR lockState = 'free'
 * OR ((lockState = 'apply' OR lockState = 'rollback'
 *      OR lockState = 'finalize' OR lockState = 'dying')
 *     AND heartbeatAt < :staleCutoff)
 * ```
 *
 * `release` and `failed` are intentionally NOT in the takeover allowlist for
 * apply/finalize — those require an explicit `unlock` (LCK-08).
 *
 * **OQ9 — rollback acquire widening.** When `args.mode === 'rollback'`, the
 * condition additionally permits `lockState ∈ {release, failed}` (the
 * post-release lifecycle states) so Case 2 and Case 3 rollback can acquire
 * the lock without first running `unlock` to clear to `free`. An active
 * (non-stale) `lockState='rollback'` is still rejected (one rollback at a
 * time). Apply and finalize modes are unchanged.
 *
 * Rollback mode (OQ9 widening):
 * ```
 * attribute_not_exists(lockState)
 * OR lockState = 'free'
 * OR lockState = 'release'
 * OR lockState = 'failed'
 * OR ((lockState = 'apply' OR lockState = 'rollback'
 *      OR lockState = 'finalize' OR lockState = 'dying')
 *     AND heartbeatAt < :staleCutoff)
 * ```
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
export async function acquire(service: MigrationsServiceBundle, config: ResolvedConfig, args: AcquireArgs): Promise<void> {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - config.lock.staleThresholdMs).toISOString();

  /**
   * Build the LCK-01 ConditionExpression for the given acquire mode.
   *
   * - `apply` / `finalize`: original condition; no scope change.
   * - `rollback` (OQ9): widened to permit `release` and `failed` so post-release
   *   Case 2 + Case 3 rollback can acquire. Rejects an active (non-stale)
   *   `rollback` (one rollback at a time); a stale `rollback` is still
   *   takeover-eligible via the heartbeatAt branch.
   *
   * Inlined here to capture `staleCutoff` from the enclosing scope so
   * ElectroDB's where-clause type inference is preserved.
   */
  function buildAcquireWhereExpression(
    mode: 'apply' | 'rollback' | 'finalize',
  ): (attrs: { lockState: unknown; heartbeatAt: unknown }, op: {
    notExists: (a: unknown) => string;
    eq: (a: unknown, v: unknown) => string;
    lt: (a: unknown, v: unknown) => string;
  }) => string {
    return ({ lockState, heartbeatAt }, op) => {
      const free = `${op.notExists(lockState)} OR ${op.eq(lockState, 'free')}`;
      const stale = `((${op.eq(lockState, 'apply')} OR ${op.eq(lockState, 'rollback')} OR ${op.eq(lockState, 'finalize')} OR ${op.eq(lockState, 'dying')}) AND ${op.lt(heartbeatAt, staleCutoff)})`;
      if (mode === 'rollback') {
        // OQ9 — permit release/failed entry for post-release rollback.
        return `${free} OR ${op.eq(lockState, 'release')} OR ${op.eq(lockState, 'failed')} OR ${stale}`;
      }
      return `${free} OR ${stale}`;
    };
  }

  let result: TransactionWriteResult;
  try {
    result = (await service.service.transaction
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
          .where(buildAcquireWhereExpression(args.mode))
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
      .go()) as TransactionWriteResult;
  } catch (err) {
    // Defense-in-depth: AWS SDK paths that bypass ElectroDB's wrapper still
    // throw the raw TransactionCanceledException. The result-shape branch below
    // handles the normal ElectroDB v3 path where the rejection is surfaced as
    // `{canceled: true, data: [...]}`.
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

  if (isResultConditionalCheckFailed(result)) {
    const reason = extractResultCancellationReason(result);
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
}
