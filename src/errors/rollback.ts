import { EDBMigrationError } from './base.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Thrown by
 * `src/rollback/audit.ts`'s `assertInvariant()` when `scanned !== reverted + skipped + failed`.
 *
 * Surfaced to operators via `_migration_runs.error.code` after `markFailed`.
 *
 * This mirrors the `EDBBatchWriteExhaustedError` pattern in
 * `src/safety/batch-write-retry.ts` — internal-only with a stable code string.
 *
 * Design rationale (RBK-12 / RESEARCH §Section 6 lines 1344-1356):
 * The rollback orchestrator maintains a count audit triple (scanned, reverted,
 * skipped, failed) similar to Phase 4's apply-flow audit. If the counts do not
 * reconcile after the full rollback scan loop, this error is thrown before
 * `markReverted` — preventing a partially-executed rollback from being marked
 * as complete. The operator must investigate and re-run or force-unlock.
 *
 * Caller's remediation:
 * - Check `_migration_runs.itemCounts` for the audit triple.
 * - Re-run `rollback` (acquires from `failed` state per OQ9 widening).
 * - Or run `unlock` if the table is in an inconsistent state.
 */
export class EDBRollbackCountMismatchError extends EDBMigrationError {
  readonly code = 'EDB_ROLLBACK_COUNT_MISMATCH' as const;
}
