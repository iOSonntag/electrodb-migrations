/**
 * Stable error-code strings — the single source of truth. Every `EDB*` error
 * class reads its `code` from here, and every duck-typed checker compares
 * against the same constants. Pitfall #8 (typo at one site or the other ⇔
 * silent checker failure) is prevented by sourcing both ends from this file.
 *
 * Adding a new code: also add a corresponding class in `classes.ts` and a
 * checker in `checkers.ts`. Never inline `'EDB_*'` literals elsewhere.
 */
export const ERROR_CODES = {
  MIGRATION_IN_PROGRESS: 'EDB_MIGRATION_IN_PROGRESS',
  LOCK_HELD: 'EDB_MIGRATION_LOCK_HELD',
  REQUIRES_ROLLBACK: 'EDB_REQUIRES_ROLLBACK',
  ROLLBACK_NOT_POSSIBLE: 'EDB_ROLLBACK_NOT_POSSIBLE',
  ROLLBACK_OUT_OF_ORDER: 'EDB_ROLLBACK_OUT_OF_ORDER',
  STALE_ENTITY_READ: 'EDB_STALE_ENTITY_READ',
  SELF_READ_IN_MIGRATION: 'EDB_SELF_READ_IN_MIGRATION',
} as const;

/** Reason codes carried in `EDBRollbackNotPossibleError.details.reason`. README §9.5. */
export const ROLLBACK_REASON_CODES = {
  NO_DOWN_FN: 'no-down-fn',
  NO_RESOLVER: 'no-resolver',
  FINALIZED_ONLY_PROJECTED: 'finalized-only-projected',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type RollbackReasonCode = (typeof ROLLBACK_REASON_CODES)[keyof typeof ROLLBACK_REASON_CODES];
