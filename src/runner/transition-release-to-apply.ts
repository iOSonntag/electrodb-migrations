import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/**
 * Inputs for {@link transitionReleaseToApply}. The `migId` field is carried
 * for call-site symmetry with `appendInFlight` but is not read by this
 * verb — Plan 09 calls `appendInFlight` before this verb to advance
 * `lockMigrationId` + `inFlightIds`.
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
 * mark. ConditionExpression: `lockRunId = :runId AND lockState = 'release'`.
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
    .where(({ lockRunId, lockState }, op) =>
      `${op.eq(lockRunId, args.runId)} AND ${op.eq(lockState, 'release')}`,
    )
    .go();
}
