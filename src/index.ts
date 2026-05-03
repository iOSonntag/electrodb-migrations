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
 * Later phases extend this surface:
 * - Phase 3 adds `createMigrationsClient` (programmatic API surface)
 * - Phase 9 adds `createLambdaMigrationHandler`
 *
 * Internal-only error classes (`EDBConfigLoadError`, `EDBSnapshotMalformedError`,
 * `EDBSnapshotVersionTooNewError`, `EDBBatchWriteExhaustedError`,
 * `EDBConfigInvariantViolationError`) are NOT re-exported. Internal helpers
 * (`resolveConfig`, `loadConfigFile`, `fingerprintEntityModel`, etc.) are
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
