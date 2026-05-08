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
      void markFailed(args.service, {
        runId: args.runId,
        ...(args.migId !== undefined ? { migId: args.migId } : {}),
        cause: err,
      });
    },
  });
}
