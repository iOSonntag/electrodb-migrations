import type { ResolvedConfig } from './types.js';

/**
 * Default `entities` path scaffolded by `init` and supplied by `resolveConfig`
 * when the user omits the field. Matches README §5.1.1.
 */
export const DEFAULT_ENTITIES_PATH = 'src/database/entities' as const;

/**
 * Default `migrations` path scaffolded by `init` and supplied by `resolveConfig`
 * when the user omits the field. Matches README §5.1.1.
 */
export const DEFAULT_MIGRATIONS_PATH = 'src/database/migrations' as const;

/**
 * Lock-state-machine tuning defaults. README §5.1.3.
 *
 * - `heartbeatMs`: how often the lock holder writes a heartbeat. 30s is the
 *   §5.3 sweet spot — frequent enough that a dead Lambda is detected within
 *   a few minutes, infrequent enough not to contend with itself on the hot
 *   lock row.
 * - `staleThresholdMs`: 4h. Aggressive enough to free locks left behind by a
 *   crashed runner; conservative enough to never free a slow legitimate
 *   migration.
 * - `acquireWaitMs`: 15s. Pre-write window so guarded clients can refresh
 *   their cache before the runner starts writing. CRITICAL: must remain
 *   strictly greater than `guard.cacheTtlMs` (Pitfall #2; enforced in
 *   Plan 06's `invariants.ts`).
 */
export const DEFAULT_LOCK: ResolvedConfig['lock'] = {
  heartbeatMs: 30_000,
  staleThresholdMs: 4 * 60 * 60 * 1000, // 4h — README L801 verbatim
  acquireWaitMs: 15_000,
};

/**
 * Guard-wrapper tuning defaults. README §5.1.4.
 *
 * - `cacheTtlMs`: 5s. Per-process cache lifetime for the lock-row read.
 *   Bounded below `acquireWaitMs` (15s) to satisfy the Pitfall-#2 invariant.
 * - `blockMode`: `'all'`. Both reads and writes hit the guard. Set to
 *   `'writes-only'` for read-heavy fleets that can tolerate stale reads
 *   during a migration window.
 */
export const DEFAULT_GUARD: ResolvedConfig['guard'] = {
  cacheTtlMs: 5_000,
  blockMode: 'all',
};

/**
 * Runner reserved slot — the v0.1 runner ignores `concurrency > 1`. CFG-08.
 * Setting >1 emits a stderr warning per Assumption A8 (informational; no
 * functional change).
 */
export const DEFAULT_RUNNER: ResolvedConfig['runner'] = {
  concurrency: 1,
};

/**
 * Default DDB primary-key attribute names. README §5.1.2. Override via
 * `config.keyNames` when the user's table uses different attribute names
 * (e.g. `PK` / `SK`).
 *
 * ElectroDB's own `__edb_e__` / `__edb_v__` identifier markers are NOT
 * redeclared here. When the user does not override `keyNames.electroEntity`
 * / `keyNames.electroVersion`, the framework forwards no `identifiers`
 * option to ElectroDB and ElectroDB uses its own defaults — so if a future
 * ElectroDB version changes those marker names, this library does not
 * silently freeze the old values.
 */
export const DEFAULT_KEY_NAMES = {
  partitionKey: 'pk',
  sortKey: 'sk',
} as const;
