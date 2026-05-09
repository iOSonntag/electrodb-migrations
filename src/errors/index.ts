export { EDBMigrationError } from './base.js';
export {
  EDBMigrationInProgressError,
  EDBMigrationLockHeldError,
  EDBRequiresRollbackError,
  EDBRollbackNotPossibleError,
  EDBRollbackOutOfOrderError,
  EDBSelfReadInMigrationError,
  EDBStaleEntityReadError,
  type RollbackReasonCode,
} from './classes.js';
export { isMigrationInProgress } from './checkers.js';
export { ERROR_CODES, ROLLBACK_REASON_CODES, type ErrorCode } from './codes.js';
export { EDBRollbackCountMismatchError } from './rollback.js';
export { EDBUnlockRequiresConfirmationError } from './unlock.js';
