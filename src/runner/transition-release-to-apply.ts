import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/**
 * Inputs for {@link transitionReleaseToApply}. The `migId` field names the
 * migration that is about to enter `apply` state — `appendInFlight` (called
 * immediately before this verb) sets `lockMigrationId = migId`, and this
 * verb's WHERE clause asserts that invariant before flipping the state.
 */
export interface TransitionReleaseToApplyArgs {
  runId: string;
  migId: string;
}

/**
 * Runner-only release→apply hand-off (RUN-05 / LCK-05).
 *
 * Single-entity patch — flips `lockState='release' → 'apply'` and refreshes
 * `heartbeatAt` so the runner's heartbeat scheduler resumes from a fresh
 * mark. ConditionExpression: `lockRunId = :runId AND lockState = 'release'
 * AND lockMigrationId = :migId`.
 *
 * The `lockMigrationId = :migId` clause provides defense in depth: it pins
 * the transition to the migration that `appendInFlight` just advanced the
 * lock to. If a maintainer ever reorders the `appendInFlight` /
 * `transitionReleaseToApply` call pair, or if an operator manually patches
 * `lockMigrationId` between the two calls, the WHERE clause fails closed
 * via `ConditionalCheckFailedException` rather than silently transitioning
 * with a stale `lockMigrationId`.
 *
 * **Internal:** sole caller is `src/runner/apply-batch.ts`. NOT re-exported
 * from `src/index.ts`. Promoted to `src/state-mutations/` only when more
 * callers materialize (Phase 5+).
 *
 * **No try/catch.** ElectroDB throws `ConditionalCheckFailedException`
 * directly on a WHERE-clause failure; the runner's outer loop surfaces
 * the throw to the operator (apply-batch's catch path calls
 * `markFailed`).
 *
 * **Reference shape:** `tests/integration/lock/multi-migration-batch.test.ts`
 * lines 91-95 prove the patch on DDB Local.
 */
export async function transitionReleaseToApply(
  service: MigrationsServiceBundle,
  args: TransitionReleaseToApplyArgs,
): Promise<void> {
  const now = new Date().toISOString();
  await service.migrationState
    .patch({ id: MIGRATION_STATE_ID })
    .set({ lockState: 'apply', heartbeatAt: now, updatedAt: now })
    .where(({ lockRunId, lockState, lockMigrationId }, op) =>
      `${op.eq(lockRunId, args.runId)} AND ${op.eq(lockState, 'release')} AND ${op.eq(lockMigrationId, args.migId)}`,
    )
    .go();
}
