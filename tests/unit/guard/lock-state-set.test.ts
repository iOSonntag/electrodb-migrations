/**
 * Snapshot test for `GATING_LOCK_STATES` (GRD-04, WAVE0-NOTES Decision A7).
 *
 * The set MUST exclude `'finalize'` — README §1 wins over REQUIREMENTS.md
 * GRD-04 per CLAUDE.md DST-01 ("README is the documentation contract"). The
 * contradiction is logged in `03-WAVE0-NOTES.md` for an explicit retrospective
 * resolution rather than a silent rewrite.
 *
 * Test serves as a tripwire: any future commit that adds `'finalize'` (or any
 * other state) trips this test, forcing the author to re-read WAVE0-NOTES
 * before changing the contract.
 */
import { describe, expect, it } from 'vitest';
import { GATING_LOCK_STATES } from '../../../src/guard/lock-state-set.js';

describe('GATING_LOCK_STATES (GRD-04, Decision A7)', () => {
  it('has exactly 5 members', () => {
    expect(GATING_LOCK_STATES.size).toBe(5);
  });

  it('contains apply, rollback, release, failed, dying', () => {
    for (const state of ['apply', 'rollback', 'release', 'failed', 'dying']) {
      expect(GATING_LOCK_STATES.has(state)).toBe(true);
    }
  });

  it('does NOT contain finalize (Decision A7 — README §1 wins)', () => {
    expect(GATING_LOCK_STATES.has('finalize')).toBe(false);
  });

  it('does NOT contain free (no migration in progress when free)', () => {
    expect(GATING_LOCK_STATES.has('free')).toBe(false);
  });
});
