/**
 * Phase 3 coverage audit — Plan 03-08 defense-in-depth.
 *
 * **Purpose:** Phase 3 (internal entities + lock + guard) introduces 24
 * requirement IDs that must be exercised by tests:
 *
 *   - ENT-01..06 (internal entities: schema, enums, key overrides, Service composition)
 *   - LCK-01..10 (lock subsystem: acquire/heartbeat/transition/clear/markFailed/unlock/etc)
 *   - GRD-01..07 (guard subsystem: middleware install, ConsistentRead, cache, gating, classify, fail-closed, thaw guard)
 *   - BLD-04     (eventual-consistency simulator for the integration-test-only DDB Local gap)
 *
 * Each ID should appear as a literal string in at least one Phase 3 test
 * file's source — typically inside a `describe(...)` or `it(...)` label, or a
 * leading JSDoc paragraph. The grep is what code review uses to follow a
 * requirement to its tests; if the literal disappears, the breadcrumb breaks.
 *
 * **What this test does:** scans every `.ts` file under `tests/unit/` and
 * `tests/integration/` (excluding `tests/fixtures/`) for each requirement ID.
 * If an ID is missing AND is not on the `KNOWN_GAPS` list, the test fails
 * with a directive pointing the author at the SUMMARY for that gap's status.
 *
 * **Why a `KNOWN_GAPS` allowlist:** the audit is a *tripwire*, not a coverage
 * report. A failing test on every run is noise. Real gaps are documented
 * explicitly (with a SUMMARY pointer) so reviewers see them; SILENT gaps are
 * what this test catches. When a gap is closed, the entry leaves the list and
 * the audit becomes stricter automatically.
 *
 * **Goal state:** `KNOWN_GAPS = []`. Every entry here is a Phase 3 follow-up
 * the orchestrator is expected to address.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PHASE_3_REQUIREMENT_IDS: readonly string[] = [
  // ENT — internal entities
  'ENT-01',
  'ENT-02',
  'ENT-03',
  'ENT-04',
  'ENT-05',
  'ENT-06',
  // LCK — lock subsystem
  'LCK-01',
  'LCK-02',
  'LCK-03',
  'LCK-04',
  'LCK-05',
  'LCK-06',
  'LCK-07',
  'LCK-08',
  'LCK-09',
  'LCK-10',
  // GRD — guard subsystem
  'GRD-01',
  'GRD-02',
  'GRD-03',
  'GRD-04',
  'GRD-05',
  'GRD-06',
  'GRD-07',
  // BLD — eventual-consistency build helper
  'BLD-04',
];

/**
 * IDs that are intentionally NOT yet covered by any Phase 3 test, with a
 * rationale and a pointer for the orchestrator follow-up.
 *
 * **Goal state:** empty array. Every entry is a tracked gap.
 */
const KNOWN_GAPS: readonly { id: string; reason: string }[] = [
  {
    id: 'LCK-06',
    reason:
      'No Phase 3 test references LCK-06. The ID is not present in src/, tests/, or any Phase 3 SUMMARY. Plan 03-08 surfaces this as an orchestrator follow-up rather than silently inserting the literal — see 03-08-SUMMARY.md "Phase-3 Coverage Gaps" section. Resolution: orchestrator confirms the LCK-06 requirement scope and routes a quick task to add the missing test (or removes the ID if it has been deprecated upstream).',
  },
];

const TEST_ROOTS: readonly string[] = ['tests/unit', 'tests/integration'];

const collectTestFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // Skip fixture directories — they are not Phase 3 coverage; they are inputs.
        if (entry === 'fixtures') continue;
        walk(full);
        continue;
      }
      if (stat.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
};

/**
 * The audit file itself enumerates every requirement ID in
 * `PHASE_3_REQUIREMENT_IDS` — if it were included in the corpus, every ID
 * would always look "covered" and the tripwire would never fire. Excluding
 * the audit's own path forces the audit to find IDs in *other* test files.
 */
const SELF_PATH_SUFFIX = 'tests/unit/integration-coverage-audit.test.ts';

describe('Phase 3 requirement-ID coverage audit', () => {
  it('every Phase 3 requirement ID appears in at least one test file (modulo KNOWN_GAPS)', () => {
    const files: string[] = [];
    for (const root of TEST_ROOTS) {
      files.push(...collectTestFiles(root));
    }
    expect(files.length, 'audit must observe at least one test file under tests/unit/ or tests/integration/').toBeGreaterThan(0);

    const corpusFiles = files.filter((f) => !f.endsWith(SELF_PATH_SUFFIX));
    expect(corpusFiles.length, 'audit must observe Phase 3 test files OTHER than itself').toBeGreaterThan(0);
    const corpus = corpusFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    const knownGapIds = new Set(KNOWN_GAPS.map((g) => g.id));
    const missing: string[] = [];
    for (const id of PHASE_3_REQUIREMENT_IDS) {
      if (knownGapIds.has(id)) continue;
      if (!corpus.includes(id)) {
        missing.push(id);
      }
    }

    // Build an actionable failure message for the assertion error.
    const directive = [
      'Phase 3 coverage audit detected requirement IDs that are silently missing from all test files.',
      '',
      'Resolution options:',
      '  (a) Add the requirement ID as a literal string to a relevant test file (e.g. inside a describe/it label).',
      '  (b) If the gap is intentional and tracked, add an entry to KNOWN_GAPS in this file with a reason and SUMMARY pointer.',
      '  (c) If the requirement has been deprecated upstream, remove the ID from PHASE_3_REQUIREMENT_IDS.',
      '',
      'Do NOT silently delete the assertion — the tripwire exists to catch exactly this case.',
    ].join('\n');
    expect(missing, directive).toEqual([]);
  });

  it('every Phase 3 requirement ID is either covered OR documented as a known gap (no orphans)', () => {
    const trackedIds = new Set(PHASE_3_REQUIREMENT_IDS);
    const orphanGaps = KNOWN_GAPS.filter((g) => !trackedIds.has(g.id));
    expect(orphanGaps, 'KNOWN_GAPS contains IDs not in PHASE_3_REQUIREMENT_IDS — clean up the gap entry').toEqual([]);
  });

  it('KNOWN_GAPS entries each carry a non-trivial rationale (orchestrator follow-up clarity)', () => {
    for (const gap of KNOWN_GAPS) {
      expect(gap.reason.length, `KNOWN_GAPS entry for ${gap.id} must carry a real reason — empty/placeholder rejected`).toBeGreaterThan(40);
    }
  });
});
