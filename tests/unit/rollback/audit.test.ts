/**
 * Unit tests for createRollbackAudit — RBK-12 count-audit invariant accumulator.
 *
 * Mirrors the count-audit pattern from src/runner/count-audit.ts but replaces
 * `migrated` with `reverted` and throws EDBRollbackCountMismatchError on invariant
 * break instead of a plain Error.
 */
import { describe, expect, it } from 'vitest';
import { EDBRollbackCountMismatchError } from '../../../src/errors/index.js';
import { createRollbackAudit } from '../../../src/rollback/audit.js';

describe('createRollbackAudit', () => {
  it('fresh audit snapshot returns all zeros', () => {
    const audit = createRollbackAudit();
    expect(audit.snapshot()).toEqual({
      scanned: 0,
      reverted: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('5 scanned + 5 reverted passes assertInvariant', () => {
    const audit = createRollbackAudit();
    for (let i = 0; i < 5; i++) audit.incrementScanned();
    audit.addReverted(5);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('5 scanned + 3 reverted + 1 skipped + 1 failed passes assertInvariant', () => {
    const audit = createRollbackAudit();
    for (let i = 0; i < 5; i++) audit.incrementScanned();
    audit.addReverted(3);
    audit.incrementSkipped();
    audit.incrementFailed();
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('5 scanned + 3 reverted (no other increments) throws EDBRollbackCountMismatchError', () => {
    const audit = createRollbackAudit();
    for (let i = 0; i < 5; i++) audit.incrementScanned();
    audit.addReverted(3);
    expect(() => audit.assertInvariant()).toThrow(EDBRollbackCountMismatchError);
  });

  it('addReverted(-1) throws', () => {
    const audit = createRollbackAudit();
    expect(() => audit.addReverted(-1)).toThrow();
  });

  it('addDeleted(-1) throws', () => {
    const audit = createRollbackAudit();
    expect(() => audit.addDeleted(-1)).toThrow();
  });

  it('snapshot returns a frozen object', () => {
    const audit = createRollbackAudit();
    expect(Object.isFrozen(audit.snapshot())).toBe(true);
  });

  it('EDBRollbackCountMismatchError thrown carries details with all count fields', () => {
    const audit = createRollbackAudit();
    for (let i = 0; i < 5; i++) audit.incrementScanned();
    audit.addReverted(3);
    audit.incrementSkipped();
    // scanned=5, reverted=3, skipped=1, deleted=0, failed=0 → 5 !== 4 → throws

    let caughtErr: unknown;
    try {
      audit.assertInvariant();
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeInstanceOf(EDBRollbackCountMismatchError);
    const e = caughtErr as EDBRollbackCountMismatchError;
    expect(e.details).toMatchObject({
      scanned: 5,
      reverted: 3,
      deleted: 0,
      skipped: 1,
      failed: 0,
    });
  });
});
