import { describe, expect, it } from 'vitest';
import { createCountAudit } from '../../../src/runner/count-audit.js';

describe('createCountAudit (RUN-04 count-audit invariant)', () => {
  it('1. fresh accumulator returns all-zero snapshot', () => {
    const audit = createCountAudit();
    expect(audit.snapshot()).toEqual({ scanned: 0, migrated: 0, skipped: 0, failed: 0 });
  });

  it('2. increment paths each step their counter by 1; addMigrated(n) adds n; addMigrated(0) is a no-op', () => {
    const audit = createCountAudit();
    audit.incrementScanned();
    audit.incrementSkipped();
    audit.incrementFailed();
    audit.addMigrated(5);
    audit.addMigrated(0);
    expect(audit.snapshot()).toEqual({ scanned: 1, migrated: 5, skipped: 1, failed: 1 });
  });

  it('3. assertInvariant does NOT throw on success path (scanned == migrated + skipped)', () => {
    const audit = createCountAudit();
    // scanned=10, migrated=8 (two addMigrated calls), skipped=2, failed=0
    for (let i = 0; i < 10; i++) audit.incrementScanned();
    audit.addMigrated(3);
    audit.addMigrated(5);
    for (let i = 0; i < 2; i++) audit.incrementSkipped();
    expect(() => audit.assertInvariant()).not.toThrow();
    expect(audit.snapshot()).toEqual({ scanned: 10, migrated: 8, skipped: 2, failed: 0 });
  });

  it('4. assertInvariant does NOT throw on fail-fast path (scanned == migrated + skipped + 1)', () => {
    const audit = createCountAudit();
    // scanned=5, migrated=3, skipped=1, failed=1
    for (let i = 0; i < 5; i++) audit.incrementScanned();
    audit.addMigrated(3);
    audit.incrementSkipped();
    audit.incrementFailed();
    expect(() => audit.assertInvariant()).not.toThrow();
    expect(audit.snapshot()).toEqual({ scanned: 5, migrated: 3, skipped: 1, failed: 1 });
  });

  it('5. assertInvariant throws on over-count with exact triple and RUN-04 in message', () => {
    const audit = createCountAudit();
    // scanned=10, migrated=11, skipped=0, failed=0 — over-count
    for (let i = 0; i < 10; i++) audit.incrementScanned();
    audit.addMigrated(11);
    expect(() => audit.assertInvariant()).toThrow(/scanned=10 != migrated=11 \+ skipped=0 \+ failed=0/);
    expect(() => audit.assertInvariant()).toThrow(/RUN-04/);
  });

  it('6. assertInvariant throws on under-count (9 != 10)', () => {
    const audit = createCountAudit();
    // scanned=10, migrated=8, skipped=1, failed=0 — under-count (9 != 10)
    for (let i = 0; i < 10; i++) audit.incrementScanned();
    audit.addMigrated(8);
    audit.incrementSkipped();
    expect(() => audit.assertInvariant()).toThrow(/scanned=10 != migrated=8 \+ skipped=1 \+ failed=0/);
  });

  it('7. snapshot is independent: subsequent increments do NOT mutate the snapshot', () => {
    const audit = createCountAudit();
    audit.incrementScanned();
    audit.addMigrated(1);
    const snap = audit.snapshot();
    // Mutate audit after snapshot
    audit.incrementScanned();
    audit.incrementSkipped();
    // snap must remain unchanged
    expect(snap).toEqual({ scanned: 1, migrated: 1, skipped: 0, failed: 0 });
    expect(audit.snapshot()).toEqual({ scanned: 2, migrated: 1, skipped: 1, failed: 0 });
  });

  it('8. addMigrated rejects negative values', () => {
    const audit = createCountAudit();
    expect(() => audit.addMigrated(-1)).toThrow();
  });
});
