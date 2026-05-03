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
 * The single post-merge invariants pass for the resolved config. Asserts
 * the constraints that no individual layer can express on its own:
 *
 *   1. `tableName` reaches the resolved config from SOME layer (entry #4 of
 *      the 260503-u88 quick task). Optional in the input shape so it can
 *      come from a CLI flag or runtime arg, but a missing `tableName`
 *      after merge is fatal.
 *   2. When `remote` is defined, BOTH `remote.url` and `remote.apiKey` are
 *      non-empty (entries #3 / #5). The input shape allows partial
 *      `remote` so a CLI flag can supply one half; the post-merge check
 *      rejects partial remotes that fail to compose into a full pair.
 *   3. Pitfall #2 — `guard.cacheTtlMs` MUST be strictly less than
 *      `lock.acquireWaitMs`. README §5.3 documents why: if the guard cache
 *      outlives the runner's pre-write window, app processes can read
 *      `lockState='free'` from cache while the runner has already started
 *      writing.
 *
 * The framework refuses to start when ANY of these invariants is violated.
 * Each error is named and shaped distinctly so the operator can read the
 * stack trace and know exactly what to tune.
 *
 * Re-asserted on every CLI command boot (cheap; defends against runtime
 * config mutation in tests).
 */
export function validateConfigInvariants(config: ResolvedConfig): void {
  // Entry #4 — `tableName` must reach the resolved config from some layer.
  if (
    config.tableName === undefined ||
    (typeof config.tableName === 'string' && config.tableName.trim() === '')
  ) {
    throw new EDBConfigInvariantViolationError(
      'Configuration is missing `tableName`. Set it in electrodb-migrations.config.ts, pass --table on the CLI, or supply it as a runtime argument.',
      { field: 'tableName' },
    );
  }

  // Entries #3 / #5 — when `remote` is defined, BOTH fields must be present.
  if (config.remote !== undefined) {
    const missing: string[] = [];
    if (!config.remote.url || config.remote.url.trim() === '') missing.push('remote.url');
    if (!config.remote.apiKey || config.remote.apiKey.trim() === '') missing.push('remote.apiKey');
    if (missing.length > 0) {
      throw new EDBConfigInvariantViolationError(
        `Configuration has \`remote\` defined but is missing required field(s): ${missing.join(', ')}. Either supply both \`url\` and \`apiKey\`, or omit \`remote\` entirely.`,
        { field: 'remote', missing },
      );
    }
  }

  // Pitfall #2 — §5.3 timing invariant.
  const { cacheTtlMs } = config.guard;
  const { acquireWaitMs } = config.lock;
  if (cacheTtlMs >= acquireWaitMs) {
    throw new EDBConfigInvariantViolationError(
      `Configuration violates the §5.3 timing invariant: guard.cacheTtlMs (${cacheTtlMs}ms) must be strictly less than lock.acquireWaitMs (${acquireWaitMs}ms). Current headroom: ${acquireWaitMs - cacheTtlMs}ms (must be > 0). See README §5.3 for tuning guidance.`,
      { cacheTtlMs, acquireWaitMs, headroomMs: acquireWaitMs - cacheTtlMs },
    );
  }
}
