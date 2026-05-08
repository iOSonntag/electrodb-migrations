import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/** Inputs for {@link heartbeat}. */
export interface HeartbeatArgs {
  /**
   * The runId acquired by `acquire`. Included in the ConditionExpression to
   * defend Pitfall #5: after `unlock --run-id <prev>` and a re-acquire by a
   * new runner, the prior runner's next heartbeat tick MUST NOT land on the
   * new lock row. The runId condition guarantees the prior runner's write
   * fails with `ConditionalCheckFailedException`, which the heartbeat
   * scheduler counts toward `maxConsecutiveFailures: 2` (LCK-10).
   */
  runId: string;
}

/**
 * Heartbeat write — exactly ONE `_migration_state.patch().set({heartbeatAt,
 * updatedAt}).where(...).go()`.
 *
 * **ConditionExpression** (Pitfall #5 + active-state guard):
 *
 *   lockRunId = :myRunId
 *   AND (lockState = 'apply' OR lockState = 'rollback'
 *        OR lockState = 'finalize' OR lockState = 'dying')
 *
 * The active-state filter is intentional — heartbeats during `release` or
 * `failed` are programming errors (the runner is no longer the live owner).
 *
 * **No try/catch.** ElectroDB throws `ConditionalCheckFailedException`
 * directly when the where-clause fails; the heartbeat scheduler catches it
 * and counts it toward LCK-10's 2-failure abort threshold. Swallowing the
 * throw here would defeat the abort path.
 *
 * Wave 0 fallback (Decision A1/A2): the IN-clause is composed as a four-way
 * OR because ElectroDB's `op.contains(list, attr)` signature does not exist.
 */
export async function heartbeat(service: MigrationsServiceBundle, args: HeartbeatArgs): Promise<void> {
  const now = new Date().toISOString();
  await service.migrationState
    .patch({ id: MIGRATION_STATE_ID })
    .set({ heartbeatAt: now, updatedAt: now })
    .where(
      ({ lockRunId, lockState }, op) =>
        `${op.eq(lockRunId, args.runId)} AND (${op.eq(lockState, 'apply')} OR ${op.eq(lockState, 'rollback')} OR ${op.eq(lockState, 'finalize')} OR ${op.eq(lockState, 'dying')})`,
    )
    .go();
}
