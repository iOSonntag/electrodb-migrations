import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/** Inputs for {@link transitionToReleaseMode}. */
export interface TransitionArgs {
  /** The runId completing this migration. */
  runId: string;
  /** The migration id transitioning to release-mode. */
  migId: string;
  /**
   * Outcome of the run. `'applied'` for a successful apply; `'reverted'` for
   * a successful rollback. The verb writes `appliedAt`/`appliedRunId` for
   * the former and `revertedAt`/`revertedRunId` for the latter.
   */
  outcome: 'applied' | 'reverted';
  /** Audit-row counts captured at apply/rollback completion (optional). */
  itemCounts?: {
    scanned: number;
    migrated: number;
    skipped: number;
    failed: number;
  };
  /** The rollback strategy that was used (only present for `outcome='reverted'`). */
  rollbackStrategy?: 'projected' | 'snapshot' | 'fill-only' | 'custom';
}

/**
 * Release-mode handoff (LCK-05) — flip the lock to `release` and finalize
 * both audit rows in a single 3-item transactWrite.
 *
 * **Item order (Pitfall #7):**
 * 0. `_migration_state` patch — `lockState='release'`, `inFlightIds -= migId`,
 *    `releaseIds += migId`. ConditionExpression:
 *      `lockRunId = :runId AND (lockState = 'apply' OR lockState = 'rollback')`
 *    The `(apply OR rollback)` filter rejects double-transitions and admin
 *    races; the runId pin ensures the right runner is doing the handoff.
 * 1. `_migrations` patch — `status` flips to the outcome plus the matching
 *    timestamp+runId fields and any audit metadata.
 * 2. `_migration_runs` patch — `status='completed'`, `completedAt=now`,
 *    `lastHeartbeatAt=now`.
 *
 * **Multi-migration batches (Phase 4 territory):** the runner's apply-batch
 * loop calls this verb at each migration boundary, then immediately calls
 * `acquire(mode='apply')` (allowed from `release` because the takeover path
 * intentionally does not — the loop manages its own continuation; see
 * Plan 04). Phase 3 just exposes the verb.
 *
 * **No try/catch.** The runner is the only caller; cancellation here means
 * an operator unlock raced with the transition. The runner's outer loop
 * surfaces the throw to the operator.
 */
export async function transitionToReleaseMode(service: MigrationsServiceBundle, args: TransitionArgs): Promise<void> {
  const now = new Date().toISOString();
  const isApply = args.outcome === 'applied';

  await service.service.transaction
    .write(({ migrationState, migrations, migrationRuns }) => [
      // Item 0 — _migration_state
      migrationState
        .patch({ id: MIGRATION_STATE_ID })
        .set({ lockState: 'release', heartbeatAt: now, updatedAt: now })
        .delete({ inFlightIds: [args.migId] })
        .add({ releaseIds: [args.migId] })
        .where(({ lockRunId, lockState }, op) => `${op.eq(lockRunId, args.runId)} AND (${op.eq(lockState, 'apply')} OR ${op.eq(lockState, 'rollback')})`)
        .commit(),
      // Item 1 — _migrations
      migrations
        .patch({ id: args.migId })
        .set({
          status: args.outcome,
          ...(isApply ? { appliedAt: now, appliedRunId: args.runId } : { revertedAt: now, revertedRunId: args.runId }),
          ...(args.itemCounts ? { itemCounts: args.itemCounts } : {}),
          ...(args.rollbackStrategy ? { rollbackStrategy: args.rollbackStrategy } : {}),
        })
        .commit(),
      // Item 2 — _migration_runs
      migrationRuns
        .patch({ runId: args.runId })
        .set({ status: 'completed', completedAt: now, lastHeartbeatAt: now })
        .commit(),
    ])
    .go();
}
