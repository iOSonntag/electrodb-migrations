export { createMigrationsClient } from './core/client.js';
export type { MigrationsClient } from './core/client.js';
export { defineMigration } from './core/define-migration.js';
export type { MigrationDefinition } from './core/define-migration.js';
export { fingerprint, toCanonicalJSON } from './core/fingerprint.js';
export { MIGRATION_STATE_ID } from './entities/migration-state.js';

// M2 error hierarchy.
export {
  ElectroDBMigrationError,
  FingerprintMismatchError,
  LockHeldError,
  LockLostError,
  MigrationFailedError,
  MigrationInProgressError,
  RequiresRollbackError,
  RollbackNotPossibleError,
} from './errors.js';
export type {
  LockOperation,
  MigrationInProgressFields,
  RollbackNotPossibleReason,
} from './errors.js';

// Public types.
export type {
  ApplyOptions,
  CreateMigrationsClientOptions,
  EnsureAppliedOptions,
  FinalizeOptions,
  GetStatusOptions,
  IdentifiersConfig,
  MigrationBlockReason,
  MigrationGuardState,
  MigrationLockState,
  MigrationProgressEvent,
  MigrationRecord,
  MigrationStatus,
  ReleaseDeploymentBlockOptions,
  RollbackOptions,
} from './types.js';

// Guard wrapper (advanced use).
export { wrapClientWithMigrationGuard } from './guard/wrap-client.js';
export type { WrapClientOptions } from './guard/wrap-client.js';
