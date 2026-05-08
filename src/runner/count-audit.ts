/**
 * RUN-04 count-audit invariant accumulator.
 *
 * Pinned definition (Plan 04-02 / OQ-1): `scanned` = records pulled off the v1 cursor up to the
 * moment of decision. Success: `scanned == migrated + deleted + skipped`; fail-fast:
 * `scanned == migrated + deleted + skipped + 1`. `migrated` is apply-only (v2 writes);
 * `deleted` is finalize-only (v1 reaps); they never both increment in the same flow.
 *
 * {@link ItemCounts} mirrors `_migrations.itemCounts` (src/internal-entities/migrations.ts).
 * OQ-2 disposition: `up()` returning null/undefined is a `skipped` increment (not `failed`).
 *
 * **WR-05 disposition:** `deleted` is a separate slot from `migrated` so consumers
 * of `history --json` can distinguish apply-time v2 writes from finalize-time v1
 * reaps. Apply rows leave `deleted` at 0; finalize rows leave `migrated` at 0.
 */
export interface ItemCounts {
  readonly scanned: number;
  readonly migrated: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface CountAudit {
  incrementScanned(): void;
  incrementSkipped(): void;
  incrementFailed(): void;
  addMigrated(n: number): void;
  addDeleted(n: number): void;
  snapshot(): ItemCounts;
  assertInvariant(): void;
}

export function createCountAudit(): CountAudit {
  let scanned = 0,
    migrated = 0,
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
    addMigrated: (n: number) => {
      if (n < 0) throw new Error(`count-audit.addMigrated received negative value ${n}; runner bug. RUN-04`);
      migrated += n;
    },
    addDeleted: (n: number) => {
      if (n < 0) throw new Error(`count-audit.addDeleted received negative value ${n}; runner bug. RUN-04`);
      deleted += n;
    },
    snapshot: (): ItemCounts => Object.freeze({ scanned, migrated, deleted, skipped, failed }),
    assertInvariant: () => {
      if (scanned !== migrated + deleted + skipped + failed) {
        throw new Error(
          `Count audit invariant violated: scanned=${scanned} != migrated=${migrated} + deleted=${deleted} + skipped=${skipped} + failed=${failed}. RUN-04`,
        );
      }
    },
  };
}
