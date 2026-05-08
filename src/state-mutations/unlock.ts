import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';
import { CONSISTENT_READ } from '../safety/index.js';
import { markFailed } from './mark-failed.js';

/** Inputs for {@link unlock}. */
export interface UnlockArgs {
  /**
   * The runId the operator passed to `unlock --run-id <runId>`. The conditional
   * write enforces this matches the lock row's `lockRunId`, so a stale operator
   * command cannot clobber a freshly-acquired lock.
   */
  runId: string;
}

/** Result of {@link unlock} — surfaced to the CLI for operator messaging. */
export interface UnlockResult {
  priorState: 'free' | 'apply' | 'rollback' | 'finalize' | 'release' | 'failed' | 'dying';
}

/**
 * Admin-path state-aware unlock (LCK-08).
 *
 * Reads the lock row ONCE with `consistent: CONSISTENT_READ` (the named
 * import, NOT a literal `true` — Phase 1 source-scan invariant), then
 * dispatches per the state truth table:
 *
 * | priorState                                | action                         |
 * |-------------------------------------------|--------------------------------|
 * | `apply`, `rollback`, `finalize`, `dying`  | {@link markFailed} dispatch    |
 * | `release`, `failed`                       | forced clear (LCK-09 bypass)   |
 * | `free`                                    | no-op                          |
 *
 * The forced-clear branch deliberately omits the `attribute_not_exists(inFlightIds)`
 * condition that {@link clear} enforces (LCK-09). That's the operator escape hatch:
 * an admin running `unlock` is explicitly overriding the in-flight check; the
 * trust boundary "operator with table access can clear the lock" is already
 * given by IAM (T-03-18 disposition).
 *
 * `clear` (the LCK-09-strict path) is NOT reused here because the forced-clear
 * needs to succeed even when `inFlightIds` is non-empty.
 */
export async function unlock(service: MigrationsServiceBundle, args: UnlockArgs): Promise<UnlockResult> {
  const res = await service.migrationState.get({ id: MIGRATION_STATE_ID }).go({ consistent: CONSISTENT_READ });

  // ElectroDB's typed `data` is the row or null; we duck-type to lockState.
  const data = (res as { data: Record<string, unknown> | null }).data;

  if (!data || data.lockState === 'free') {
    return { priorState: 'free' };
  }

  const lockState = data.lockState as UnlockResult['priorState'];

  if (lockState === 'apply' || lockState === 'rollback' || lockState === 'finalize' || lockState === 'dying') {
    const migId = typeof data.lockMigrationId === 'string' ? data.lockMigrationId : undefined;
    await markFailed(service, {
      runId: args.runId,
      ...(migId !== undefined ? { migId } : {}),
      cause: new Error(`unlock --run-id ${args.runId} forced clear from state ${lockState}`),
    });
    return { priorState: lockState };
  }

  // release | failed → forced clear (bypass LCK-09).
  if (lockState === 'release' || lockState === 'failed') {
    const now = new Date().toISOString();
    await service.migrationState
      .patch({ id: MIGRATION_STATE_ID })
      .set({ lockState: 'free', updatedAt: now })
      .remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt'])
      .where(({ lockRunId }, op) => op.eq(lockRunId, args.runId))
      .go();
    return { priorState: lockState };
  }

  // Unreachable — every enum value above is handled.
  return { priorState: lockState };
}
