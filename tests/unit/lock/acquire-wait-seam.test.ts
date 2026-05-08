/**
 * LCK-04 source-scan tripwire — Plan 03-08 defense-in-depth.
 *
 * **Purpose:** the `acquireWaitMs` seam is documented in JSDoc on
 * `src/lock/acquire.ts`. Phase 4's runner is the only caller that knows to
 * `await sleep(config.lock.acquireWaitMs)` AFTER `acquireLock` returns and
 * BEFORE the first transform write — the orchestrator does NOT silently sleep
 * (Plan 03-04 Decision: "LCK-04 acquireWaitMs is documented as the runner's
 * responsibility; orchestrators do NOT silently sleep").
 *
 * If a future commit drops the JSDoc (e.g. someone "tidies up" `acquire.ts`
 * during Phase 4 and removes the LCK-04 paragraph because `acquireLock` itself
 * doesn't issue the wait), the runner author has no breadcrumb pointing at the
 * load-bearing safety invariant `guard.cacheTtlMs < lock.acquireWaitMs`. Once
 * the breadcrumb is gone, the next runner refactor risks dropping the wait
 * entirely → silent corruption becomes possible.
 *
 * **Tripwire:** this test asserts the `LCK-04` requirement ID AND the
 * `acquireWaitMs` config name both still appear in `src/lock/acquire.ts`. Any
 * commit that removes either trips this test, forcing the author to either
 * (a) keep the breadcrumb in `acquire.ts` or (b) re-locate it explicitly and
 * update this test to point at the new home.
 *
 * Why a source-scan rather than a behavior assertion: `acquireLock` does NOT
 * call `sleep` and never will. The contract IS the JSDoc. A behavior test
 * cannot defend a documented seam; only a source-scan can.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ACQUIRE_FILE = 'src/lock/acquire.ts';

describe('LCK-04 acquireWaitMs seam tripwire (src/lock/acquire.ts)', () => {
  it('src/lock/acquire.ts JSDoc still names the LCK-04 requirement ID', () => {
    const src = readFileSync(ACQUIRE_FILE, 'utf8');
    expect(src, `${ACQUIRE_FILE} must mention LCK-04 — see test file JSDoc for rationale`).toMatch(/LCK-04/);
  });

  it('src/lock/acquire.ts JSDoc still names the acquireWaitMs config seam', () => {
    const src = readFileSync(ACQUIRE_FILE, 'utf8');
    expect(src, `${ACQUIRE_FILE} must mention acquireWaitMs — Phase 4 runner needs this breadcrumb`).toMatch(/acquireWaitMs/);
  });

  it('src/lock/acquire.ts JSDoc names the safety invariant linking guard.cacheTtlMs and lock.acquireWaitMs', () => {
    const src = readFileSync(ACQUIRE_FILE, 'utf8');
    // The invariant connects the guard cache TTL and the acquire wait so the
    // breadcrumb leads BOTH directions. Either phrase form passes — what
    // matters is that an engineer who lands here from a Phase 4 review reads
    // the cause/effect link.
    const linksGuardToWait = /guard\.cacheTtlMs\s*<\s*lock\.acquireWaitMs/.test(src) || (/cacheTtlMs/.test(src) && /acquireWaitMs/.test(src) && /invariant/i.test(src));
    expect(linksGuardToWait, `${ACQUIRE_FILE} JSDoc must connect guard.cacheTtlMs to lock.acquireWaitMs`).toBe(true);
  });

  it('src/lock/acquire.ts does NOT silently issue a sleep — the wait is the runner\'s job', () => {
    const src = readFileSync(ACQUIRE_FILE, 'utf8');
    // No sleep / setTimeout / setInterval in the body. JSDoc may reference
    // them by name; we only fail on a code call. Strip comment-only lines
    // before scanning so JSDoc that NAMES sleep doesn't trip.
    const stripped = src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (t.startsWith('//')) return false;
        if (t.startsWith('/*')) return false;
        if (t.startsWith('*')) return false;
        return true;
      })
      .join('\n');
    expect(stripped, 'acquireLock body must not call sleep/setTimeout/setInterval').not.toMatch(/\bsleep\s*\(/);
    expect(stripped, 'acquireLock body must not call setTimeout').not.toMatch(/\bsetTimeout\s*\(/);
    expect(stripped, 'acquireLock body must not call setInterval').not.toMatch(/\bsetInterval\s*\(/);
  });
});
