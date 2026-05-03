import { EDBMigrationError } from './base.js';
import { ERROR_CODES, type RollbackReasonCode } from './codes.js';

/**
 * Thrown when conditional-write lock acquisition fails (lock currently held by
 * another runner). Documented in README §9.2.
 */
export class EDBMigrationLockHeldError extends EDBMigrationError {
  readonly code = ERROR_CODES.LOCK_HELD;
}

/**
 * Thrown by the migration guard when app traffic hits a guarded client while
 * the lock is in `{apply, finalize, rollback, release, failed, dying}`.
 * Documented in README §9.3. User code uses `isMigrationInProgress(err)`.
 */
export class EDBMigrationInProgressError extends EDBMigrationError {
  readonly code = ERROR_CODES.MIGRATION_IN_PROGRESS;
}

/**
 * Thrown by the runner when a previous failed apply left v2 records on disk
 * and the user has not yet run `rollback`. Documented in README §9.4.
 */
export class EDBRequiresRollbackError extends EDBMigrationError {
  readonly code = ERROR_CODES.REQUIRES_ROLLBACK;
}

/**
 * Thrown when a rollback strategy is not viable for the given lifecycle case.
 * `details.reason: RollbackReasonCode` carries the specific cause:
 * `'NO_DOWN_FUNCTION'`, `'NO_RESOLVER'`, or `'FINALIZED_ONLY_PROJECTED'`.
 * Documented in README §9.5.
 */
export class EDBRollbackNotPossibleError extends EDBMigrationError {
  readonly code = ERROR_CODES.ROLLBACK_NOT_POSSIBLE;
  // Caller passes details: { reason: RollbackReasonCode, ...extras }
}

/**
 * Thrown when `rollback <id>` targets a non-head migration (a newer applied
 * migration exists for the same entity). Documented in README §9.6.
 */
export class EDBRollbackOutOfOrderError extends EDBMigrationError {
  readonly code = ERROR_CODES.ROLLBACK_OUT_OF_ORDER;
}

/**
 * Thrown by `ctx.entity(Y)` when on-disk Y's snapshot fingerprint does not
 * match the imported Y's fingerprint (a later migration on Y has shipped that
 * the calling migration was not authored against). Documented in README §9.7.
 */
export class EDBStaleEntityReadError extends EDBMigrationError {
  readonly code = ERROR_CODES.STALE_ENTITY_READ;
}

/**
 * Thrown by `ctx.entity(X)` when called from inside X's own migration (a
 * migration cannot read its own pre-/post-state via `ctx`). Documented in
 * README §9.8.
 */
export class EDBSelfReadInMigrationError extends EDBMigrationError {
  readonly code = ERROR_CODES.SELF_READ_IN_MIGRATION;
}

// Re-export the reason-code type so callers of EDBRollbackNotPossibleError
// can typecheck their `details.reason` literal.
export type { RollbackReasonCode };
