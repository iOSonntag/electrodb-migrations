/**
 * RUN-04 count-audit invariant accumulator.
 *
 * Pinned definition (Plan 04-02 / OQ-1): `scanned` = records pulled off the v1 cursor up to the
 * moment of decision. Success: `scanned == migrated + skipped`; fail-fast: `scanned == migrated + skipped + 1`.
 *
 * {@link ItemCounts} mirrors `_migrations.itemCounts` (src/internal-entities/migrations.ts:64-72).
 * OQ-2 disposition: `up()` returning null/undefined is a `skipped` increment (not `failed`).
 */
export interface ItemCounts {
  readonly scanned: number;
  readonly migrated: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface CountAudit {
  incrementScanned(): void;
  incrementSkipped(): void;
  incrementFailed(): void;
  addMigrated(n: number): void;
  snapshot(): ItemCounts;
  assertInvariant(): void;
}

export function createCountAudit(): CountAudit {
  let scanned = 0, migrated = 0, skipped = 0, failed = 0;
  return {
    incrementScanned: () => { scanned++; },
    incrementSkipped: () => { skipped++; },
    incrementFailed: () => { failed++; },
    addMigrated: (n: number) => {
      if (n < 0) throw new Error(`count-audit.addMigrated received negative value ${n}; runner bug. RUN-04`);
      migrated += n;
    },
    snapshot: (): ItemCounts => Object.freeze({ scanned, migrated, skipped, failed }),
    assertInvariant: () => {
      if (scanned !== migrated + skipped + failed) {
        throw new Error(`Count audit invariant violated: scanned=${scanned} != migrated=${migrated} + skipped=${skipped} + failed=${failed}. RUN-04`);
      }
    },
  };
}
