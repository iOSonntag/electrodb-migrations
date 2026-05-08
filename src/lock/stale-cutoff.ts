import type { ResolvedConfig } from '../config/index.js';

/**
 * Returns the ISO-8601 timestamp before which a heartbeat is considered stale.
 *
 * Single source of truth for the cutoff math so all callers (acquire's
 * `where(heartbeatAt < :staleCutoff)` ConditionExpression, integration tests,
 * and the future `validate`-phase rules) agree.
 *
 * **Phase 3 callers:** `state-mutations/acquire.ts` already inlines the math
 * via `config.lock.staleThresholdMs`; this helper exists so future lock-row
 * consumers (e.g. the `status` command in Phase 4 reporting "X minutes until
 * takeover") can call the same function instead of re-implementing the
 * subtraction.
 */
export function staleCutoffIso(config: ResolvedConfig): string {
  return new Date(Date.now() - config.lock.staleThresholdMs).toISOString();
}
