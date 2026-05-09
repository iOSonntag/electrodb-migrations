---
phase: 04-apply-release-finalize-runner
plan: 15
subsystem: testing
tags:
  - integration
  - phase-04
  - wave-5
  - gap-closure
  - audit-row
  - bl-01
  - regression-test

# Dependency graph
requires:
  - phase: 04-apply-release-finalize-runner
    provides: "BL-01 fix in commit 22d2fc8 — single _migrations.put() in applyFlowScanWrite with conditional spreads for hasDown / hasRollbackResolver / reads (placeholder fingerprint='')"
  - phase: 04-apply-release-finalize-runner
    provides: "ENT-03 / CTX-06 schema attributes on the _migrations entity (hasDown, hasRollbackResolver, reads as set<string>)"
  - phase: 04-apply-release-finalize-runner
    provides: "tests/integration/runner/_helpers.ts setupApplyTestTable() bundle (service, doc, raw, v1Entity, v2Entity, migration, cleanup)"
provides:
  - "Regression-test coverage for the post-BL-01 _migrations audit-row shape"
  - "Two integration test cases (full-feature + bare) that pin every conditional-spread branch"
  - "Defence against future refactors that re-introduce a second clobbering write, hardcode the conditional flags, or drift the placeholder fingerprint from ''"
affects:
  - 05-rollback (post-finalize rollback strategies read hasDown / hasRollbackResolver from this exact audit row to refuse projected/fill-only/custom strategies)
  - 06-cross-entity-reads (ctx.entity proxy uses migration.reads — the persisted Set is the source of truth at validate time)
  - 07-validate-gate (overwrites placeholder fingerprint='' with the real sha256; this test pins the placeholder semantics until that lands)

# Tech tracking
tech-stack:
  added: []  # No new deps; pure regression test
  patterns:
    - "Two-describe / one-it-each pattern for table-isolated integration tests (mirrors apply-failure-fail-fast.test.ts)"
    - "Inline normalizeReads() helper in test files for AWS-SDK Set/array shape tolerance — avoids new helper modules"
    - "Distinct migration id ('gap-04-15-...') for full-feature case to keep audit row unambiguous in trace/debugging"

key-files:
  created:
    - "tests/integration/runner/apply-audit-row-shape.test.ts (241 lines, 2 describe blocks, 2 it() blocks)"
  modified: []

key-decisions:
  - "Used setup.v2Entity for the reads[] declaration (model.entity === 'User'); single entity exercises the same conditional-spread branch as N entities"
  - "Two SEPARATE describe blocks (each with own beforeAll/afterAll) for table isolation — full-feature uses custom id but distinct tables defend against future shared-state assumptions"
  - "normalizeReads() handles undefined / null / Set / array / { wrapperName: 'Set', values } — defensive against AWS SDK marshalling drift"
  - "Returned arrays are sorted alphabetically for order-independent assertions"
  - "Asserted fingerprint === '' (empty string, not undefined) because the schema declares fingerprint: required:true and the post-fix code passes '' as a Phase-7 placeholder"

patterns-established:
  - "Audit-row shape regression tests live alongside the runner integration tests under tests/integration/runner/, NOT under a separate gap-closure directory"
  - "Inline migration construction (spread bare fixture + add optional fields) is the preferred pattern for one-off feature combinations — do NOT add throwaway fixtures under tests/_helpers/sample-migrations/"
  - "All post-apply DDB read-backs go through runUnguarded(() => ...) because createMigrationsClient attaches guard middleware to the shared docClient stack"

requirements-completed:
  - RUN-02
  - RUN-09

# Metrics
duration: ~12min
completed: 2026-05-09
---

# Phase 4 Plan 15: BL-01 audit-row-shape regression test Summary

**Two-case integration test pinning the post-BL-01 _migrations audit-row shape: full-feature migrations record hasDown/hasRollbackResolver/reads, bare migrations leave them absent — both write fingerprint='' and kind='transform'**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-05-09T08:13:00Z
- **Completed:** 2026-05-09T08:19:00Z
- **Tasks:** 1 (single-task TDD plan; the BL-01 source fix already shipped in commit 22d2fc8 so the test went RED→GREEN→PASS in one author-and-run loop)
- **Files modified:** 1 created, 0 modified
- **Test runtime:** ~1.7s for the new file alone (2 tests; ~600ms each); ~5.5s contribution to the full integration suite

## Accomplishments

- Closed the gap surfaced in `04-UAT.md` Test #2: BL-01's source-only fix (commit 22d2fc8 — 3 inserts, 24 deletes, zero test files) now has automated regression coverage.
- New integration suite `tests/integration/runner/apply-audit-row-shape.test.ts` runs against the same DDB Local backend as every other Phase 4 runner test (no new helpers, no new fixtures, no new infrastructure).
- Two-case structure pins BOTH branches of the post-fix conditional spreads:
  - **Test 1 (full-feature):** all three optional flags PRESENT (`hasDown`, `hasRollbackResolver`, `reads: Set('User')`).
  - **Test 2 (bare):** all three optional flags ABSENT (conditional spreads correctly skipped).
- Asserts fingerprint='' (Phase 7 placeholder) and kind='transform' (only v0.1 kind value) in both cases.
- 04-UAT.md Test #2 can now be re-run with `result: pass` — runtime semantics are pinned.

## Task Commits

Each task was committed atomically:

1. **Task 1: apply-audit-row-shape integration test** - `05f0eca` (test)

**Plan metadata:** _committed by orchestrator after worktree merge_

_Note: This is a TDD plan; the GREEN gate was already satisfied by the BL-01 source fix in commit 22d2fc8 (which predates this plan). The new test file passes 2/2 against unchanged source — exactly the regression-backfill outcome the plan called for._

## Files Created/Modified

### Created
- `tests/integration/runner/apply-audit-row-shape.test.ts` — 241 lines. Self-contained integration test file; two describe blocks each with their own beforeAll/afterAll (table-per-suite isolation); inline normalizeReads helper; verbatim copy of the testConfig literal from apply-happy-path-1k.test.ts.

### Test cases (for changelog reference)
1. **`BL-01 gap closure: full-feature migration audit-row shape > writes _migrations row with fingerprint='', kind='transform', hasDown/hasRollbackResolver/reads populated`**
   - Builds a full-feature migration inline (id `gap-04-15-User-add-status-full`) by spreading the bare fixture and adding `down`, `rollbackResolver: () => null`, and `reads: [setup.v2Entity]`.
   - Calls `client.apply()`; `result.applied` length is 1.
   - Read-back via `runUnguarded(() => setup.service.migrations.get({ id: ... }).go())`.
   - Assertions:
     - `r.fingerprint === ''`
     - `r.kind === 'transform'`
     - `r.hasDown === true`
     - `r.hasRollbackResolver === true`
     - `normalizeReads(r.reads)` deep-equals `['User']`
2. **`BL-01 gap closure: bare migration audit-row shape > writes _migrations row with fingerprint='', kind='transform', and hasDown/hasRollbackResolver/reads ABSENT (conditional spreads skipped)`**
   - Uses `setup.migration` as-shipped (no down, no rollbackResolver, no reads).
   - Calls `client.apply()`; `result.applied` length is 1.
   - Read-back via the same unguarded `service.migrations.get(...)` pattern.
   - Assertions:
     - `r.fingerprint === ''`
     - `r.kind === 'transform'`
     - `r.hasDown` is undefined
     - `r.hasRollbackResolver` is undefined
     - `normalizeReads(r.reads)` is undefined

## Decisions Made

- **Single-entity reads declaration** (rather than two distinct entity refs): plan recommendation; one entity exercises the same conditional-spread BRANCH as N entities — adding a second entity is not a different code path. Chose simplicity.
- **Distinct migration id for the full-feature case** (`gap-04-15-User-add-status-full`): defends against future shared-state assumptions if someone collapses the two describes into one.
- **Two describe blocks (table-per-suite)** rather than one describe with two `it()` calls sharing a table: simplest correctness story; both apply paths target the User-add-status migration id, so sharing a table would mean the second apply hits an already-applied row.
- **Inline normalizeReads helper** rather than promoting to `tests/integration/_helpers/`: plan rule 3 (no new helpers); this is a one-file utility.
- **Returned arrays from normalizeReads are sorted**: makes `toEqual(['User'])` order-independent against any future SDK marshalling change.
- **Suppressed RUN-09 stderr summary via `vi.spyOn(process.stderr, 'write')`**: same pattern as `apply-batch.test.ts` — keeps test output clean without coupling to the summary's exact text (apply-happy-path-1k.test.ts already pins that).

## Deviations from Plan

None - plan executed exactly as written.

The plan's `<action>` block specified the file structure to the line; the actual file matches that spec verbatim, with the only post-author change being Biome auto-applied formatting + safe lint fixes (line-length, optional-chain, literal-keys) — those are stylistic alignments to the project's Biome config, not deviations from the plan.

## Issues Encountered

### Pre-existing failures detected (out of scope)

Two integration tests in unrelated files were observed to fail against the same base commit (`f8f8405`) with NO modifications outside this plan's new test file. Both are logged in `.planning/phases/04-apply-release-finalize-runner/deferred-items.md` as `DI-04-15-01` and `DI-04-15-02`:

- **`tests/integration/runner/finalize.test.ts`** asserts `itemCounts.migrated === 100` at line 80; commit `e22e35d` (WR-05) added a separate `deleted` slot to ItemCounts but the test was not updated. One-liner fix: read `itemCounts.deleted`.
- **`tests/integration/runner/guarded-write-at-boundary.test.ts`** intermittently has 2-of-20 guarded writes succeed (instead of 0) when run as part of the full integration suite. Passes in tighter isolation. Looks like cross-test state-leak; needs broader isolation work.

Per executor SCOPE BOUNDARY rule, neither was fixed in this plan — they predate the new file's branch base and have nothing to do with the BL-01 audit-row backfill.

### Biome lint warnings on new file

After authoring, `pnpm check` (Biome) flagged 13 issues:
- 1 `lint/style/noNonNullAssertion` (`result.applied[0]!.migId`)
- 12 `lint/complexity/useLiteralKeys` (`r['fingerprint']` etc.)

Sibling tests in `tests/integration/runner/` ALSO fail Biome with similar warnings, but the plan's explicit success-criteria item required `pnpm check` clean on the new file. Applied `npx biome check --write --unsafe` to fix all 13: replaced `!` with `?.` and replaced bracket-string property access with dot-notation. Re-ran tests after fixes — still 2/2 passing in 1.7s.

## User Setup Required

None — no external service configuration required.

## Confirmation: BL-01 runtime semantics pinned

A future refactor that:
- removes the conditional spread for `hasDown` / `hasRollbackResolver` / `reads` will fail Test 1 (full-feature case);
- hardcodes those flags or makes them unconditional will fail Test 2 (bare case);
- re-introduces a second clobbering write or changes the placeholder fingerprint to a non-empty default will fail both tests' `expect(r.fingerprint).toBe('')` assertion;
- changes `kind` to anything other than `'transform'` for v0.1 transform migrations will fail both tests.

04-UAT.md Test #2 ("BL-01 audit row shape — single `_migrations` write") can now be re-run with **result: pass** — automated regression coverage exists for every claim that test was supposed to verify.

## Next Phase Readiness

- Phase 4 gap from 04-UAT.md Test #2 is closed.
- No open blockers for Phase 5 (rollback): the audit row's `hasDown` / `hasRollbackResolver` flags are now both written by source AND verified by automated regression tests, which Phase 5 (RBK-09 post-finalize rollback) reads to refuse incompatible strategies.
- Pre-existing failures in `finalize.test.ts` and `guarded-write-at-boundary.test.ts` are tracked in `deferred-items.md` for a separate follow-up — they do not block Phase 5 entry.

## Self-Check: PASSED

- File `tests/integration/runner/apply-audit-row-shape.test.ts` exists (241 lines, 2 describe blocks, 2 it() blocks): FOUND.
- Commit `05f0eca` is present in `git log --oneline`: FOUND.
- `pnpm vitest run --config vitest.integration.config.ts tests/integration/runner/apply-audit-row-shape.test.ts` reports 2/2 passing in ~1.7s: VERIFIED.
- `npx tsc --noEmit` exits zero: VERIFIED.
- `npx biome check tests/integration/runner/apply-audit-row-shape.test.ts` exits zero ("Checked 1 file in 2ms. No fixes applied."): VERIFIED.
- No source under `src/` modified: VERIFIED (`git diff src/` empty).
- No file under `tests/_helpers/sample-migrations/` modified: VERIFIED.
- `tests/integration/runner/_helpers.ts` not modified: VERIFIED.
- No file under `tests/integration/_helpers/` modified: VERIFIED.

---
*Phase: 04-apply-release-finalize-runner*
*Completed: 2026-05-09*
