import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { type HeartbeatScheduler, startHeartbeatScheduler } from '../safety/index.js';
import { heartbeat as heartbeatMutation, markFailed } from '../state-mutations/index.js';

/** Inputs for {@link startLockHeartbeat}. `migId` is forwarded to {@link markFailed} on LCK-10 abort. */
export interface StartLockHeartbeatArgs {
  service: MigrationsServiceBundle;
  config: ResolvedConfig;
  runId: string;
  migId?: string;
}

/**
 * Thin wrapper over Phase 1's {@link startHeartbeatScheduler}.
 *
 * **Forbidden: `setInterval`** (Pitfall #2 — Lambda-freeze queue thaw). Phase 1's
 * self-rescheduling setTimeout chain is the only acceptable timer.
 * `tests/unit/lock/source-scan.test.ts` enforces.
 *
 * **`maxConsecutiveFailures` is NOT overridden** — Phase 1's default of 2 is
 * exactly LCK-10's spec.
 */
export function startLockHeartbeat(args: StartLockHeartbeatArgs): HeartbeatScheduler {
  return startHeartbeatScheduler({
    intervalMs: args.config.lock.heartbeatMs,
    work: () => heartbeatMutation(args.service, { runId: args.runId }),
    onAbort: (err) => {
      // CR-04 fix: attach a `.catch` rather than `void`-ing the Promise.
      // The most likely rejection here is `EDBMigrationLockHeldError` from
      // markFailed when another runner has taken over (the lockRunId WHERE
      // clause no longer matches). On Node 15+ an unhandled rejection
      // crashes the host process — that is exactly the wrong outcome on the
      // path that was supposed to be the safety net. Diagnostic-only logging
      // here; the runner's outer loop has already lost the lock and will
      // exit on its next acquireLock guard regardless.
      markFailed(args.service, {
        runId: args.runId,
        ...(args.migId !== undefined ? { migId: args.migId } : {}),
        cause: err,
      }).catch((markFailedErr) => {
        // eslint-disable-next-line no-console -- diagnostic only; framework has no logger surface in v0.1
        console.error('[electrodb-migrations] heartbeat abort: markFailed rejected:', markFailedErr);
      });
    },
  });
}
