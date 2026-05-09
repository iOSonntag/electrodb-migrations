/**
 * `electrodb-migrations` v0.1 public surface.
 *
 * Phase 1 ships:
 * - Eight `EDB*` error classes (the abstract base + seven concrete subclasses)
 * - `isMigrationInProgress` duck-typed checker
 * - `defineConfig` factory + `MigrationsConfig` / `ResolvedConfig` types
 *
 * Phase 2 adds:
 * - `defineMigration` factory + `Migration<From, To>` type re-export (this file)
 * - The `electrodb-migrations` CLI binary (separate `dist/cli/index.js` entry)
 *
 * Phase 4 adds:
 * - `createMigrationsClient` (programmatic API surface — API-01, API-02)
 *
 * Phase 9 adds:
 * - `createLambdaMigrationHandler`
 *
 * Internal-only error classes (`EDBConfigLoadError`, `EDBSnapshotMalformedError`,
 * `EDBSnapshotVersionTooNewError`, `EDBBatchWriteExhaustedError`,
 * `EDBConfigInvariantViolationError`) are NOT re-exported. Internal helpers
 * (`resolveConfig`, `loadConfigFile`, `fingerprintEntityModel`, `applyBatch`,
 * `finalizeFlow`, `loadPendingMigrations`, `transitionReleaseToApply`, etc.) are
 * accessed via the module-internal import paths and are not part of the v0.1
 * contract.
 *
 * The `./testing` sub-path export (TST-01, FND-03) is Phase 8 territory.
 */
export {
  EDBMigrationError,
  EDBMigrationInProgressError,
  EDBMigrationLockHeldError,
  EDBRequiresRollbackError,
  EDBRollbackNotPossibleError,
  EDBRollbackOutOfOrderError,
  EDBSelfReadInMigrationError,
  EDBStaleEntityReadError,
  isMigrationInProgress,
} from './errors/index.js';

export { defineConfig } from './config/index.js';
export type { MigrationsConfig, ResolvedConfig } from './config/index.js';

export { defineMigration } from './migrations/index.js';
export type { Migration } from './migrations/index.js';

export { createMigrationsClient } from './client/index.js';
export type { MigrationsClient } from './client/index.js';

// Phase 6 cross-entity reads — public types.
// Runtime exports `buildCtx` and `createReadOnlyFacade` are framework-internal
// and are NOT re-exported here; only the type contract is part of the
// public API consumed by `electrodb-migrations/testing` (Phase 8).
export type { MigrationCtx, ReadOnlyEntityFacade } from './ctx/index.js';
