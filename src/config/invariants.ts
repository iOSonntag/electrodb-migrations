import { EDBMigrationError } from '../errors/base.js';
import type { ResolvedConfig } from './types.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts` per A7. Surfaces
 * as a fatal startup error when the framework's load-bearing timing
 * invariant is violated.
 */
export class EDBConfigInvariantViolationError extends EDBMigrationError {
  readonly code = 'EDB_CONFIG_INVARIANT_VIOLATION' as const;
}

/**
 * Pitfall #2 — `guard.cacheTtlMs` MUST be strictly less than
 * `lock.acquireWaitMs`. README §5.3 documents why: if the guard cache
 * outlives the runner's pre-write window, app processes can read
 * `lockState='free'` from cache while the runner has already started writing.
 *
 * The framework refuses to start when this invariant is violated. The error
 * names both numbers and the computed headroom so the operator knows
 * exactly what to tune.
 *
 * Re-asserted on every CLI command boot (cheap; defends against runtime
 * config mutation in tests).
 */
export function validateConfigInvariants(config: ResolvedConfig): void {
  const { cacheTtlMs } = config.guard;
  const { acquireWaitMs } = config.lock;

  if (cacheTtlMs >= acquireWaitMs) {
    throw new EDBConfigInvariantViolationError(
      `Configuration violates the §5.3 timing invariant: ` +
        `guard.cacheTtlMs (${cacheTtlMs}ms) must be strictly less than ` +
        `lock.acquireWaitMs (${acquireWaitMs}ms). ` +
        `Current headroom: ${acquireWaitMs - cacheTtlMs}ms (must be > 0). ` +
        `See README §5.3 for tuning guidance.`,
      { cacheTtlMs, acquireWaitMs, headroomMs: acquireWaitMs - cacheTtlMs },
    );
  }
}
