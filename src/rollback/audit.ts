import { EDBRollbackCountMismatchError } from '../errors/index.js';

/**
 * RBK-12 rollback count-audit invariant accumulator.
 *
 * **Separate module from `src/runner/count-audit.ts`** (per RESEARCH §Section 4
 * line 1233): the apply-flow audit invariant is `scanned == migrated + deleted +
 * skipped + failed`; the rollback audit invariant replaces `migrated` with
 * `reverted`. Keeping them separate avoids accidental cross-contamination between
 * apply and rollback count semantics.
 *
 * Invariant: `scanned === reverted + deleted + skipped + failed`.
 * On break, throws `EDBRollbackCountMismatchError` carrying the full count tuple
 * in `details` (RBK-12). The orchestrator calls `assertInvariant()` BEFORE
 * `transitionToReleaseMode` — a break keeps the lock in `rollback` state so the
 * operator can re-run rollback.
 *
 * @throws {EDBRollbackCountMismatchError} - When assertInvariant() detects
 *   `scanned !== reverted + deleted + skipped + failed`.
 */
export interface RollbackItemCounts {
  readonly scanned: number;
  readonly reverted: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface RollbackAudit {
  incrementScanned(): void;
  incrementSkipped(): void;
  incrementFailed(): void;
  addReverted(n: number): void;
  addDeleted(n: number): void;
  snapshot(): RollbackItemCounts;
  assertInvariant(): void;
}

export function createRollbackAudit(): RollbackAudit {
  let scanned = 0,
    reverted = 0,
    deleted = 0,
    skipped = 0,
    failed = 0;
  return {
    incrementScanned: () => {
      scanned++;
    },
    incrementSkipped: () => {
      skipped++;
    },
    incrementFailed: () => {
      failed++;
    },
    addReverted: (n: number) => {
      if (n < 0) throw new Error(`rollback-audit.addReverted received negative value ${n}; rollback bug. RBK-12`);
      reverted += n;
    },
    addDeleted: (n: number) => {
      if (n < 0) throw new Error(`rollback-audit.addDeleted received negative value ${n}; rollback bug. RBK-12`);
      deleted += n;
    },
    snapshot: (): RollbackItemCounts => Object.freeze({ scanned, reverted, deleted, skipped, failed }),
    assertInvariant: () => {
      if (scanned !== reverted + deleted + skipped + failed) {
        throw new EDBRollbackCountMismatchError(
          `Count audit invariant violated: scanned=${scanned} != reverted=${reverted} + deleted=${deleted} + skipped=${skipped} + failed=${failed}. RBK-12`,
          { scanned, reverted, deleted, skipped, failed },
        );
      }
    },
  };
}
