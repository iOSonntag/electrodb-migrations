import type { ResolvedConfig } from '../config/index.js';
import { EDBMigrationLockHeldError } from '../errors/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { type AcquireArgs, acquire as acquireMutation } from '../state-mutations/index.js';
import { readLockRow } from './read-lock-row.js';

/**
 * Acquire the global migration lock with conditional-write + read-back verify.
 *
 * **Algorithm (LCK-01 + LCK-03):**
 *
 * 1. Call `state-mutations.acquire(service, config, args)`. The verb issues the
 *    2-item transactWrite whose item-0 ConditionExpression matches:
 *
 *    ```
 *    attribute_not_exists(lockState)
 *    OR lockState = 'free'
 *    OR ((lockState IN ('apply','rollback','finalize','dying'))
 *        AND heartbeatAt < :staleCutoff)
 *    ```
 *
 *    On `TransactionCanceledException` whose item-0 reason is
 *    `ConditionalCheckFailed`, the verb itself throws
 *    {@link EDBMigrationLockHeldError} with the current-holder details
 *    extracted from `CancellationReasons[0].Item` (DDB Local may omit ALL_OLD;
 *    real AWS populates it).
 *
 * 2. After the write succeeds, perform a strongly-consistent `GetItem` via
 *    {@link readLockRow} to verify our `runId` is on disk. Defends against
 *    torn reads (vanishingly rare on DDB but cheap insurance per LCK-01's
 *    "+ verify" requirement). If the row is missing or `lockRunId` does not
 *    match `args.runId` we throw {@link EDBMigrationLockHeldError}.
 *
 * **LCK-04 — pre-migration wait window IS NOT issued by this function.**
 * Phase 4's runner is responsible for awaiting `sleep(config.lock.acquireWaitMs)`
 * AFTER `acquireLock` returns and BEFORE the first transform write. The wait
 * gives any guarded process whose cache is mid-TTL time to refresh. If Phase 4
 * drops the wait, the safety invariant `guard.cacheTtlMs < lock.acquireWaitMs`
 * (validated at startup, Phase 1 `validateConfigInvariants`) would no longer
 * hold and silent corruption becomes possible. T-03-23 disposition: this seam
 * is documented here; Phase 4's runner plan must check it.
 */
export async function acquireLock(service: MigrationsServiceBundle, config: ResolvedConfig, args: AcquireArgs): Promise<void> {
  await acquireMutation(service, config, args);

  // Read-back verify — defends Pitfall #1 / torn reads on the path between
  // the conditional write committing and the runner trusting it owns the lock.
  const verify = await readLockRow(service);
  if (!verify || verify.lockRunId !== args.runId) {
    throw new EDBMigrationLockHeldError(`Lock acquire verification failed — expected runId ${args.runId}, got ${verify?.lockRunId ?? '(none)'}`, {
      ourRunId: args.runId,
      foundRunId: verify?.lockRunId,
      foundLockState: verify?.lockState,
    });
  }
}
