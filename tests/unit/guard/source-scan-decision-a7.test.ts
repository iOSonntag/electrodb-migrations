/**
 * Decision A7 source-scan tripwire — Plan 03-08 defense-in-depth.
 *
 * **Purpose:** `src/guard/lock-state-set.ts` JSDoc cites WAVE0-NOTES Decision
 * A7 ("README §1 wins over REQUIREMENTS.md GRD-04 — finalize is EXCLUDED from
 * GATING_LOCK_STATES"). The behavior tripwire in
 * `tests/unit/guard/lock-state-set.test.ts` already asserts the Set has 5
 * members and excludes `finalize`. THIS test defends the ATTRIBUTION.
 *
 * Why both? `lock-state-set.test.ts` proves the contract; this test proves
 * the contract has a written rationale a future maintainer can find. If a
 * future "doc cleanup" deletes the JSDoc that names WAVE0-NOTES Decision A7,
 * the next engineer who lands on REQUIREMENTS.md GRD-04 (which lists finalize
 * as gating) will see the implementation excludes it and have NO trail back
 * to the documented decision — they will either re-add finalize ("the
 * requirement says so") or open a follow-up ticket asking why. Both outcomes
 * are wasted cycles; preserving the citation in code is cheap.
 *
 * **Tripwire:** scans `src/guard/lock-state-set.ts` for `WAVE0-NOTES` AND
 * `Decision A7` AND `finalize` (the explicit naming of the excluded state).
 * Any commit that removes any of the three trips this test, forcing the
 * author to either keep the citation or document the relocation.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LOCK_STATE_SET_FILE = 'src/guard/lock-state-set.ts';

describe('Decision A7 source-scan tripwire (src/guard/lock-state-set.ts)', () => {
  it('cites WAVE0-NOTES as the source-of-truth for Decision A7', () => {
    const src = readFileSync(LOCK_STATE_SET_FILE, 'utf8');
    expect(src, `${LOCK_STATE_SET_FILE} must cite WAVE0-NOTES — see test JSDoc for rationale`).toMatch(/WAVE0-NOTES/);
  });

  it('cites the specific decision identifier "Decision A7"', () => {
    const src = readFileSync(LOCK_STATE_SET_FILE, 'utf8');
    expect(src, `${LOCK_STATE_SET_FILE} must name "Decision A7" so a grep across src/ leads to the rationale`).toMatch(/Decision A7/);
  });

  it('explicitly names the excluded "finalize" state in the JSDoc', () => {
    const src = readFileSync(LOCK_STATE_SET_FILE, 'utf8');
    expect(src, `${LOCK_STATE_SET_FILE} must name "finalize" so a future engineer following GRD-04 lands on the rationale`).toMatch(/finalize/);
  });

  it('cites README §1 (the documentation contract that wins per CLAUDE.md DST-01)', () => {
    const src = readFileSync(LOCK_STATE_SET_FILE, 'utf8');
    // Either "README §1" or "README" + a "§1" / "section 1" hint.
    const cites = /README\s*§?\s*1/.test(src) || (/README/.test(src) && /maintenance mode/i.test(src));
    expect(cites, `${LOCK_STATE_SET_FILE} must reference README §1 (maintenance mode does NOT gate app traffic)`).toBe(true);
  });
});
