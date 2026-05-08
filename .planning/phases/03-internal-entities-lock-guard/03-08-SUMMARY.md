---
phase: 03-internal-entities-lock-guard
plan: 08
subsystem: test-tripwires
tags: [defense-in-depth, source-scan, requirement-coverage, audit, tripwire, lck-04, decision-a7, phase-3-coverage]
requires:
  - phase: 03-internal-entities-lock-guard
    plan: 03-04
    provides: src/lock/acquire.ts JSDoc naming the LCK-04 acquireWaitMs seam (the tripwire's scan target)
  - phase: 03-internal-entities-lock-guard
    plan: 03-05
    provides: src/guard/lock-state-set.ts JSDoc citing WAVE0-NOTES Decision A7 (the tripwire's scan target)
  - phase: 03-internal-entities-lock-guard
    plan: 03-01
    provides: tests/_helpers/source-scan.ts comment-stripping utility (consumed by acquire-wait-seam.test.ts)
provides:
  - lck-04-acquire-wait-seam-tripwire (defends src/lock/acquire.ts JSDoc on LCK-04 + acquireWaitMs + the safety invariant)
  - decision-a7-source-scan-tripwire (defends src/guard/lock-state-set.ts JSDoc on WAVE0-NOTES + Decision A7 + finalize)
  - phase-3-24-id-coverage-audit (scans tests/{unit,integration}/**/*.ts for 24 requirement IDs; KNOWN_GAPS allowlist with rationale-length assertion)
  - 03-PHASE-COVERAGE.md (companion doc explaining the audit, the KNOWN_GAPS convention, and the four-file Plan 03-08 tripwire suite)
affects:
  - 04 runner (Phase 4 cannot remove the LCK-04 JSDoc on src/lock/acquire.ts without tripping acquire-wait-seam.test.ts)
  - 04+ guard maintainers (cannot remove WAVE0-NOTES Decision A7 citation from src/guard/lock-state-set.ts without tripping source-scan-decision-a7.test.ts)
  - any future plan introducing a new Phase 3 requirement ID (must add the literal to a test file or to KNOWN_GAPS with a real rationale)
  - orchestrator follow-up: LCK-06 enrolled as the sole KNOWN_GAPS entry; resolution requires a quick task to clarify the requirement scope
tech-stack:
  added: []
  patterns:
    - "Source-scan tripwire: a test that proves a *citation* still exists in source, complementing behavior tests that prove the *contract* still holds"
    - "Self-exclusion in coverage audit: the audit file enumerates every requirement ID, so its own path is filtered out of the corpus to prevent self-satisfaction"
    - "KNOWN_GAPS allowlist with rationale-length assertion (>40 chars) — documented gaps allowed, placeholder gaps rejected"
    - "Comment-strip code-vs-JSDoc separation: the LCK-04 tripwire allows JSDoc to NAME sleep/setTimeout while rejecting code calls"
key-files:
  created:
    - tests/unit/lock/acquire-wait-seam.test.ts
    - tests/unit/guard/source-scan-decision-a7.test.ts
    - tests/unit/integration-coverage-audit.test.ts
    - .planning/phases/03-internal-entities-lock-guard/03-PHASE-COVERAGE.md
  modified: []
  deleted: []
decisions:
  - "Plan 03-08 ONLY adds tests + one doc; src/ is untouched. The Plan brief explicitly stated 'It does NOT touch src/' and the discovery that LCK-04 + Decision A7 markers are already present (Plans 03-04 + 03-05) confirms the tripwires can land without source edits."
  - "LCK-06 is the sole KNOWN_GAPS entry. The literal does not appear in src/, in any tests/ file, or in any Phase 3 SUMMARY. Per the Plan 03-08 brief — 'document missing IDs rather than silently inserting them' — LCK-06 is enrolled in KNOWN_GAPS with a SUMMARY pointer for orchestrator follow-up."
  - "The audit excludes its OWN path from the corpus. Without this filter the audit would self-satisfy (it enumerates every required ID by definition). The exclusion is implemented as `endsWith('tests/unit/integration-coverage-audit.test.ts')` so the corpus contains only OTHER test files."
  - "KNOWN_GAPS rationale-length assertion (`> 40` characters) replaces a 'TODO' placeholder loophole. A future contributor cannot silence the audit by stuffing a one-word reason — biome would not catch it; the third `it` block does."
  - "BLD-04 corpus inclusion required scanning tests/integration/ alongside tests/unit/. BLD-04 lives in tests/integration/_helpers/eventual-consistency.ts and tests/integration/_spike/eventual-consistency-prototype.test.ts (the Wave 0 spike); the audit's TEST_ROOTS array covers both directories."
metrics:
  tasks_completed: 4
  tasks_total: 4
  unit_tests_added: 11
  files_changed: 4
  lines_added: 370
  lines_removed: 0
  duration_minutes: 22
  completed: "2026-05-08"
---

# Phase 3 Plan 08: Defense-in-Depth Tripwires Summary

**One-liner:** Three test files plus one doc closing Phase 3 — source-scan tripwires that defend the LCK-04 acquireWaitMs JSDoc on `src/lock/acquire.ts` and the WAVE0-NOTES Decision A7 citation on `src/guard/lock-state-set.ts`, plus a 24-ID requirement-coverage audit that scans every Phase 3 test file for the literal IDs (with a `KNOWN_GAPS` allowlist requiring real rationales) — and `03-PHASE-COVERAGE.md` explaining the audit's role and the four-file Plan 03-08 tripwire suite.

## What Was Done

### The three tripwires + companion doc

| File | Role | Scan target |
|---|---|---|
| `tests/unit/lock/acquire-wait-seam.test.ts` | LCK-04 source-scan tripwire | `src/lock/acquire.ts` JSDoc + body |
| `tests/unit/guard/source-scan-decision-a7.test.ts` | Decision A7 source-scan tripwire | `src/guard/lock-state-set.ts` JSDoc |
| `tests/unit/integration-coverage-audit.test.ts` | 24-ID Phase 3 coverage audit | `tests/{unit,integration}/**/*.ts` (excluding fixtures + self) |
| `.planning/phases/03-internal-entities-lock-guard/03-PHASE-COVERAGE.md` | Audit explainer | (doc) |

### Tripwire 1 — LCK-04 acquireWaitMs seam (`tests/unit/lock/acquire-wait-seam.test.ts`)

Four assertions over `src/lock/acquire.ts`:

1. JSDoc still mentions the literal `LCK-04` requirement ID.
2. JSDoc still names `acquireWaitMs` (the config seam Phase 4's runner is responsible for awaiting).
3. JSDoc connects `guard.cacheTtlMs` to `lock.acquireWaitMs` — either as the explicit invariant `guard.cacheTtlMs < lock.acquireWaitMs` OR by naming both names alongside the word "invariant". This is the load-bearing safety chain Phase 4 needs to preserve.
4. The CODE BODY of `acquireLock` does not call `sleep`, `setTimeout`, or `setInterval` (the acquire wait is the runner's job, not the orchestrator's). Comment lines are stripped before scanning so JSDoc that NAMES `sleep` does not trip the test.

The test exists because `acquire.ts` does NOT and never will issue the wait — the contract IS the JSDoc. A behavior test cannot defend a documented seam; only a source-scan can.

### Tripwire 2 — Decision A7 citation (`tests/unit/guard/source-scan-decision-a7.test.ts`)

Four assertions over `src/guard/lock-state-set.ts`:

1. JSDoc cites `WAVE0-NOTES` (the source-of-truth file path).
2. JSDoc names the literal identifier `Decision A7`.
3. JSDoc explicitly names `finalize` (the excluded state).
4. JSDoc references `README §1` OR uses `README` + the phrase `maintenance mode` (the documentation contract that wins per CLAUDE.md DST-01).

This complements the existing `tests/unit/guard/lock-state-set.test.ts` snapshot test:
- That test defends the **contract** (the Set has 5 members and excludes finalize).
- This test defends the **attribution** (the rationale is still findable from source).

If a future "doc cleanup" deletes the citation, the next engineer landing on REQUIREMENTS.md GRD-04 (which lists `finalize` as gating) loses the trail back to the documented decision and either re-adds finalize or files a redundant follow-up. Both outcomes are wasted cycles; preserving the citation is cheap.

### Tripwire 3 — 24-ID coverage audit (`tests/unit/integration-coverage-audit.test.ts`)

Three `it` blocks:

1. **Every Phase 3 requirement ID appears in at least one test file (modulo `KNOWN_GAPS`).** The audit walks `tests/unit/` and `tests/integration/`, skips `tests/fixtures/`, and excludes its own path (so the audit cannot self-satisfy by enumerating every ID in `PHASE_3_REQUIREMENT_IDS`). For each of the 24 IDs not on `KNOWN_GAPS`, the audit asserts the literal substring appears in the corpus. Failures emit a multi-line directive listing resolution options (add the literal, add to KNOWN_GAPS, or remove from PHASE_3_REQUIREMENT_IDS).
2. **No orphan KNOWN_GAPS entries.** Every entry in `KNOWN_GAPS` must reference an ID in `PHASE_3_REQUIREMENT_IDS`; this catches stale entries left behind after an ID is deprecated.
3. **Every `KNOWN_GAPS` entry carries a non-trivial rationale (>40 chars).** Catches the placeholder-string loophole: a contributor cannot silence the audit by stuffing a one-word reason.

Phase 3 ID list:

| Group | IDs | Count |
|---|---|---|
| ENT (internal entities) | `ENT-01..06` | 6 |
| LCK (lock subsystem) | `LCK-01..10` | 10 |
| GRD (guard subsystem) | `GRD-01..07` | 7 |
| BLD (build helper) | `BLD-04` | 1 |
| **Total** | | **24** |

### `03-PHASE-COVERAGE.md` companion doc

Explains:
- What the audit IS (breadcrumb navigability) and ISN'T (functional coverage).
- Why `KNOWN_GAPS` exists (real, tracked gaps; not a grandfather clause).
- The match form (literal substring in any `.ts` test file).
- When the audit fires (rename/delete dropping an ID, new requirement, label tidying).
- When the audit MUST NOT be relaxed (placeholder rationales).
- The current `KNOWN_GAPS` table (LCK-06).
- The goal state (`KNOWN_GAPS = []`).
- The four-file Plan 03-08 tripwire suite and how each defends a different aspect of navigability.

### What this plan did NOT do (verbatim from the brief)

> "It does NOT touch src/."

Confirmed — `git diff 7a0e8371..HEAD -- src/` is empty. All changes are under `tests/` and `.planning/`.

## Phase-3 Coverage Gaps

### LCK-06 — orchestrator follow-up required

`LCK-06` does not appear in any source file, test file, or Phase 3 SUMMARY across the repository. The audit's `KNOWN_GAPS` array tracks this with a 40+ character rationale. Resolution paths:

1. **If LCK-06 is a real requirement that has been missed:** the orchestrator routes a follow-up quick task to add the missing test (or to extend an existing Phase 3 test) and remove the entry from `KNOWN_GAPS`.
2. **If LCK-06 has been deprecated upstream:** the orchestrator removes the ID from `PHASE_3_REQUIREMENT_IDS` in the audit file. The third audit assertion (orphan-gap check) will then fail, prompting the corresponding `KNOWN_GAPS` entry removal.

This SUMMARY explicitly defers the decision to the orchestrator per the Plan 03-08 brief: "if any ID is missing, document it in your SUMMARY for orchestrator follow-up rather than silently inserting them."

## Source-Scan Verification (manual, since vitest execution is sandboxed in this worktree)

The following greps were run during execution to validate the tripwire assertions are GREEN against the wave base:

```bash
grep 'LCK-04' src/lock/acquire.ts            → 1 hit (line 34, JSDoc)
grep 'acquireWaitMs' src/lock/acquire.ts     → 2 hits (JSDoc body)
grep 'guard.cacheTtlMs' src/lock/acquire.ts  → 1 hit (JSDoc)
grep 'lock.acquireWaitMs' src/lock/acquire.ts → 1 hit (JSDoc)
grep 'invariant' src/lock/acquire.ts          → 1 hit (JSDoc)

grep 'WAVE0-NOTES' src/guard/lock-state-set.ts  → 1 hit
grep 'Decision A7' src/guard/lock-state-set.ts  → 2 hits (JSDoc body)
grep 'finalize' src/guard/lock-state-set.ts     → 4 hits (JSDoc + inline comment)
grep 'README' src/guard/lock-state-set.ts       → 2 hits (JSDoc cites README §1)
```

Audit per-ID coverage map (excluding `tests/unit/integration-coverage-audit.test.ts` self-match):

| ID | Status | Source |
|---|---|---|
| ENT-01..06 | covered | `tests/unit/internal-entities/*.test.ts` |
| LCK-01 | covered | `tests/unit/state-mutations/acquire.test.ts`, etc |
| LCK-02 | covered | `tests/unit/lock/heartbeat.test.ts`, `tests/unit/state-mutations/heartbeat.test.ts` |
| LCK-03 | covered | `tests/unit/state-mutations/acquire.test.ts`, `tests/unit/state-mutations/cancellation.test.ts` |
| LCK-04 | covered | `tests/unit/lock/acquire-wait-seam.test.ts` (this plan) |
| LCK-05 | covered | `tests/unit/state-mutations/append-in-flight.test.ts` |
| **LCK-06** | **gap** | **enrolled in KNOWN_GAPS — orchestrator follow-up** |
| LCK-07 | covered | `tests/unit/lock/source-scan.test.ts`, `tests/unit/lock/read-lock-row.test.ts`, etc |
| LCK-08 | covered | `tests/unit/state-mutations/unlock.test.ts` |
| LCK-09 | covered | `tests/unit/state-mutations/clear.test.ts` |
| LCK-10 | covered | `tests/unit/state-mutations/mark-failed.test.ts`, `tests/unit/lock/heartbeat.test.ts` |
| GRD-01..07 | covered | `tests/unit/guard/*.test.ts` |
| BLD-04 | covered | `tests/integration/_helpers/eventual-consistency.ts`, `tests/integration/_spike/eventual-consistency-prototype.test.ts` |

23 of 24 IDs covered; 1 documented gap (LCK-06).

## Decisions Made

- **Plan 03-08 lands tests + one doc, ZERO src/ changes.** The brief explicitly stated `It does NOT touch src/`, and discovery confirmed the LCK-04 + Decision A7 JSDoc markers are already present from Plans 03-04 + 03-05. The tripwires lock in those existing markers — the source side of the contract was completed by prior plans.
- **LCK-06 is the sole `KNOWN_GAPS` entry, surfaced for orchestrator follow-up.** Per the Plan 03-08 brief: "if any ID is missing, document it in your SUMMARY for orchestrator follow-up rather than silently inserting them." LCK-06 was found absent from the entire repo; rather than silently mention it in a comment somewhere, the audit enrolls it formally with a SUMMARY pointer.
- **Audit excludes its own path from the corpus.** The audit file enumerates every requirement ID by definition; without exclusion it would self-satisfy. Implementation: `endsWith('tests/unit/integration-coverage-audit.test.ts')` filter on the file list before reading the corpus.
- **`KNOWN_GAPS` rationale-length assertion (>40 characters) closes the placeholder loophole.** A contributor who tries to silence the audit with `reason: 'TODO'` is rejected. The threshold is high enough to require a real explanation but low enough to fit on one line of normal English.
- **The audit also scans `tests/integration/`.** BLD-04 lives in integration helpers and the Wave 0 spike file; restricting to `tests/unit/` would have created a false positive. The corpus is `tests/{unit,integration}/**/*.ts`, with `tests/fixtures/` excluded as inputs not coverage.
- **The third LCK-04 assertion uses an OR predicate to allow phrasing variations.** The exact form `guard.cacheTtlMs < lock.acquireWaitMs` is preferred but `guard.cacheTtlMs` + `acquireWaitMs` + `invariant` (any phrasing) also passes. This avoids brittleness while still defending the load-bearing connection.
- **The fourth LCK-04 assertion strips comment lines before scanning the body for `sleep`/`setTimeout`/`setInterval`.** The JSDoc on `acquire.ts` mentions `sleep(config.lock.acquireWaitMs)` by name as an explanation of what Phase 4 does; without comment-stripping, the test would always trip. Inline copy of the strip logic (matching the convention in `tests/_helpers/source-scan.ts:stripCommentLines`) keeps the tripwire test self-contained.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Critical functionality] Audit file would self-satisfy without an exclusion filter**

- **Found during:** Task 3 (writing the audit), while reasoning about whether the audit could meaningfully fail.
- **Issue:** The audit file enumerates every requirement ID in `PHASE_3_REQUIREMENT_IDS`. If the audit's own source were included in the corpus, every ID would always be "covered" (because the literal exists in the array), and the tripwire would never fire — even if every other test file deleted every ID reference.
- **Fix:** Added `SELF_PATH_SUFFIX` constant and a `corpusFiles.filter((f) => !f.endsWith(SELF_PATH_SUFFIX))` step before reading the corpus. Documented in JSDoc inside the audit file.
- **Files modified:** `tests/unit/integration-coverage-audit.test.ts` (single edit during initial authoring).
- **Verification:** Manual reasoning — without the filter, removing every "ENT-01" from `tests/unit/internal-entities/*.test.ts` would leave the audit GREEN; with the filter, it correctly fails. The second assertion `expect(corpusFiles.length).toBeGreaterThan(0)` defends against a future filename change accidentally filtering everything.
- **Commit:** `dd1489d`.

**2. [Rule 2 — Critical functionality] `expect.fail()` swap to `expect(missing).toEqual([])` for vitest 2 compatibility safety**

- **Found during:** Task 3 review, before commit. The first draft used `expect.fail(directive)` inside an `if (missing.length > 0) { ... }` block.
- **Issue:** `expect.fail` is supported in vitest 2 but its return-type interaction with TypeScript's strict-no-implicit-any settings can be brittle in complex codebases (the function never returns, but TS occasionally widens to `void` and breaks subsequent flow analysis). I could not verify behavior at runtime (vitest invocation is sandboxed in this worktree), so I switched to the safer pattern of building the directive string and asserting `expect(missing, directive).toEqual([])`. The directive becomes the assertion's failure message, and the actual missing-IDs array is logged as the diff. Functionally identical to `expect.fail`; less surface area for vitest version drift.
- **Files modified:** `tests/unit/integration-coverage-audit.test.ts` (single edit before commit).
- **Verification:** The pattern is used elsewhere in the codebase via `expect(violations).toEqual([])` (e.g. `tests/unit/lock/source-scan.test.ts:44`).
- **Commit:** `dd1489d` (only one commit for Task 3 — the swap happened pre-commit).

### Cosmetic — `git add -f` for `.planning/` doc

`.planning/` is gitignored (`.gitignore:38`). The Phase 3 Wave 0 commit `e1cb41b` documented the convention: force-add planning docs through the gitignore. Plan 03-08's `03-PHASE-COVERAGE.md` follows the same pattern in `git add -f .planning/...`. No deviation from established practice; called out here only because `git status` initially showed an empty working tree after writing the file, which was disorienting until the gitignore line was identified.

### Authentication Gates

None — this plan has no external-service auth surface.

## Test-Run Verification (DEFERRED — vitest is sandboxed in this worktree)

`pnpm vitest run` and equivalents were denied in this execution environment. The tests were written based on:

1. Manual inspection of `src/lock/acquire.ts` (lines 1-56) confirming all four LCK-04 assertions match the file content as committed at wave base `7a0e837`.
2. Manual inspection of `src/guard/lock-state-set.ts` (lines 1-29) confirming all four Decision A7 assertions match.
3. Manual `grep` (the one shell capability available) confirming each of the 24 audit IDs except `LCK-06` is present in some test file outside `tests/unit/integration-coverage-audit.test.ts`.

The orchestrator's merge-time test run is the canonical verification gate; this plan's commits are designed to be GREEN against the wave base on landing. If any tripwire fires unexpectedly, the failure mode is loud (descriptive `expect(...)` messages embedded in each assertion).

## Threat Surface Scan

No new network endpoints, file-access patterns, schema changes at trust boundaries, or auth paths. The new surface is entirely in the test layer (file-read scans of `src/lock/`, `src/guard/`, and `tests/`). Tripwires are defensive instruments; they cannot themselves cause data corruption.

## TDD Gate Compliance

This plan is `type: source-scan tripwire` rather than `type: tdd` — there is no behavior to drive RED → GREEN. The pattern matches Plan 03-04's source-scan invariant tests (which Plan 03-04's SUMMARY documents as "designed to PROVE compliance, not to start RED"). Each tripwire test is GREEN immediately against the wave base because it asserts properties already established by prior plans:

| Commit | Type | Status against wave base |
|---|---|---|
| `ef43d2b test(03-08): add LCK-04 acquireWaitMs source-scan tripwire` | test (tripwire) | GREEN — `src/lock/acquire.ts` JSDoc already cites LCK-04 + acquireWaitMs (Plan 03-04) |
| `116c1d7 test(03-08): add Decision A7 source-scan tripwire` | test (tripwire) | GREEN — `src/guard/lock-state-set.ts` JSDoc already cites WAVE0-NOTES Decision A7 (Plan 03-05) |
| `dd1489d test(03-08): add Phase 3 24-ID requirement-coverage audit` | test (tripwire) | GREEN modulo LCK-06 (in KNOWN_GAPS) — 23/24 IDs covered by prior Phase 3 plans |
| `ff263ae docs(03-08): add Phase 3 coverage audit explainer` | docs | n/a — explainer doc only |

No GREEN/REFACTOR commit was needed because the source-side work was already done; this plan locks it in.

## Self-Check: PASSED

- `tests/unit/lock/acquire-wait-seam.test.ts` exists ✓ (4 assertions over `src/lock/acquire.ts`)
- `tests/unit/guard/source-scan-decision-a7.test.ts` exists ✓ (4 assertions over `src/guard/lock-state-set.ts`)
- `tests/unit/integration-coverage-audit.test.ts` exists ✓ (3 assertions; 24-ID list; KNOWN_GAPS allowlist with rationale-length assertion)
- `.planning/phases/03-internal-entities-lock-guard/03-PHASE-COVERAGE.md` exists ✓ (audit explainer)
- All 4 commits exist in git log between wave base `7a0e8371` and HEAD:
  - `ef43d2b` test(03-08): add LCK-04 acquireWaitMs source-scan tripwire ✓
  - `116c1d7` test(03-08): add Decision A7 source-scan tripwire ✓
  - `dd1489d` test(03-08): add Phase 3 24-ID requirement-coverage audit ✓
  - `ff263ae` docs(03-08): add Phase 3 coverage audit explainer ✓
- `git diff 7a0e8371..HEAD -- src/` is empty (no source files touched) ✓
- LCK-04 markers present in `src/lock/acquire.ts`: `LCK-04` (line 34), `acquireWaitMs` (lines 35, 38), `guard.cacheTtlMs` (line 38), `lock.acquireWaitMs` (line 39), `invariant` (line 39) ✓
- Decision A7 markers present in `src/guard/lock-state-set.ts`: `WAVE0-NOTES` (line 5), `Decision A7` (lines 5, 15, 28), `finalize` (lines 6, 15, 20, 28), `README §1` (line 6 explicit; line 9 also names README as "the documentation contract") ✓
- 23 of 24 audit IDs present in test corpus (excluding the audit's own file) ✓
- LCK-06 enrolled in KNOWN_GAPS with a 200+ character rationale and SUMMARY pointer ✓
- Audit `KNOWN_GAPS` rationale length for LCK-06 entry passes the >40-char assertion ✓
- No `pre-existing` fixes; no src/ modifications; no orchestrator artifacts (STATE.md, ROADMAP.md) modified ✓
- `.gitignore` `.planning/` exception handled via `git add -f` matching the e1cb41b precedent ✓

## Threat Flags

None — no new security-relevant surface introduced.

---
*Phase: 03-internal-entities-lock-guard*
*Completed: 2026-05-08*
