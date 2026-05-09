/**
 * Unit tests for `findHeadViolation` — RESEARCH §Code Examples lines 880-888.
 *
 * RED phase: written before the implementation and expected to FAIL.
 *
 * RBK-01: head-only rule — a rollback target must be the LATEST applied/finalized
 * migration for its entity. If a newer one exists, return it; the caller refuses
 * the rollback.
 */
import { describe, expect, it } from 'vitest';
import { findHeadViolation } from '../../../src/rollback/head-only.js';

// ---------------------------------------------------------------------------
// Minimal row shape (subset relevant to head-only check)
// ---------------------------------------------------------------------------

type MigRow = {
  id: string;
  entityName: string;
  status: string;
  toVersion: string;
};

// ---------------------------------------------------------------------------
// Helper: build a minimal migrations row
// ---------------------------------------------------------------------------

function row(
  id: string,
  entityName: string,
  status: string,
  toVersion: string,
): MigRow {
  return { id, entityName, status, toVersion };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('findHeadViolation', () => {
  it('returns undefined when there is only the target migration (no others)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    expect(findHeadViolation([target], target)).toBeUndefined();
  });

  it('returns the newer applied migration when target is the older one (same entity)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    const newer = row('mig-2', 'User', 'applied', '3');
    expect(findHeadViolation([target, newer], target)).toEqual(newer);
  });

  it('returns undefined when target IS the newer migration (target is head)', () => {
    const older = row('mig-1', 'User', 'applied', '2');
    const target = row('mig-2', 'User', 'applied', '3');
    expect(findHeadViolation([older, target], target)).toBeUndefined();
  });

  it('returns undefined when the only newer migration is reverted (reverted does not block)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    const reverted = row('mig-2', 'User', 'reverted', '3');
    expect(findHeadViolation([target, reverted], target)).toBeUndefined();
  });

  it('returns undefined when the only newer migration is failed (failed does not block)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    const failed = row('mig-2', 'User', 'failed', '3');
    expect(findHeadViolation([target, failed], target)).toBeUndefined();
  });

  it('returns undefined when the only newer migration is pending (pending does not block)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    const pending = row('mig-2', 'User', 'pending', '3');
    expect(findHeadViolation([target, pending], target)).toBeUndefined();
  });

  it('returns undefined for cross-entity: newer Team migration does not block User rollback', () => {
    const target = row('user-mig', 'User', 'applied', '2');
    const teamNewer = row('team-mig', 'Team', 'applied', '3');
    expect(findHeadViolation([target, teamNewer], target)).toBeUndefined();
  });

  it('returns the finalized newer migration (finalized blocks, same as applied)', () => {
    const target = row('mig-1', 'User', 'applied', '2');
    const finalized = row('mig-2', 'User', 'finalized', '3');
    expect(findHeadViolation([target, finalized], target)).toEqual(finalized);
  });

  it('uses Number.parseInt so version 10 > 9 (lexically "10" < "9" but numerically 10 > 9)', () => {
    const v2 = row('mig-v2', 'User', 'applied', '2');
    const v9 = row('mig-v9', 'User', 'applied', '9');
    const v10 = row('mig-v10', 'User', 'applied', '10');

    // Target is v9; v10 exists and is applied → should return v10, not v2.
    const violation = findHeadViolation([v2, v9, v10], v9);
    expect(violation).toEqual(v10);

    // Double-check: target is v2; BOTH v9 and v10 are newer — returns one of them.
    const violation2 = findHeadViolation([v2, v9, v10], v2);
    expect(violation2).toBeDefined();
    expect(['mig-v9', 'mig-v10']).toContain(violation2?.id);
  });
});
