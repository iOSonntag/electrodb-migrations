---
phase: 06-cross-entity-reads
plan: "06"
subsystem: testing
tags: [ctx, integration, readme, phase-06, wave-5, cross-entity-reads, vitest, ddb-local]

# Dependency graph
requires:
  - phase: 06-cross-entity-reads
    provides: "Plans 01-05: ctx runtime, read-only facade, snapshot validation, rollback preconditions, sample fixtures"
provides:
  - "Four-cell SC-5 matrix integration test (declared/undeclared × in-bounds/out-of-bounds)"
  - "CTX-06 audit-row round-trip integration test (_migrations.reads persisted as Set)"
  - "CTX-08 rollback-refusal integration test (READS_DEPENDENCY_APPLIED)"
  - "Integration test helper factory: setupCtxTestTable with snapshotMode (matching/mismatched/absent)"
  - "README §6.6 updated with eager/lazy validation split and error reference table"
affects:
  - 07-validate-gate
  - 08-test-harness
  - verifier

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Direct _migrations row writes (no apply()) to keep lock in free state for rollback integration tests"
    - "normalizeReads() helper for DDB Local Set vs Array vs wrapperName shape normalization"
    - "CtxTestTableSetup factory with snapshotMode parameter (matching/mismatched/absent)"
    - "vi.spyOn(process.stderr, 'write') to suppress RUN-09 summary output in integration tests"

key-files:
  created:
    - tests/integration/ctx/_helpers.ts
    - tests/integration/ctx/ctx-read.test.ts
    - tests/integration/ctx/ctx-audit-row.test.ts
    - tests/integration/rollback/ctx08-refusal.test.ts
  modified:
    - src/rollback/preconditions.ts
    - README.md

key-decisions:
  - "Use direct _migrations row writes (not apply()) for CTX-08 test setup to avoid lock state issues"
  - "normalizeReads() defensively handles Set/Array/{wrapperName:'Set'} because DDB Local returns ElectroDB set attributes inconsistently"
  - "preconditions.ts bug fix: removed .size > 0 guard since Array.size is undefined; delegated normalization to findBlockingReadsDependency"
  - "Inline undeclared migration (no reads field) for SC-5 cells 3+4 rather than a new fixture file"

patterns-established:
  - "Integration test helpers mirror rollback/_helpers.ts shape: factory + cleanup hook returning setup bundle"
  - "Four-cell matrix pattern: separate describe blocks per cell with per-cell beforeAll/afterAll table lifecycle"
  - "ctx test isolation: each cell creates its own DDB Local table to prevent apply() state conflicts"

requirements-completed: [CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, CTX-06, CTX-08]

# Metrics
duration: ~90min
completed: 2026-05-09
---

# Phase 06 Plan 06: Cross-Entity Reads — Integration Tests + README Update Summary

**SC-5 four-cell matrix integration tests, CTX-06 audit-row round-trip, CTX-08 rollback-refusal, and README §6.6 with eager/lazy validation and error reference table**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-05-09T12:45:00Z
- **Completed:** 2026-05-09T14:16:20Z
- **Tasks:** 3
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments

- SC-5 four-cell matrix integration test proves all four declared/undeclared × in-bounds/out-of-bounds combinations against real DDB Local, including the load-bearing T-06-06-04 safety invariant (no v2 record written when buildCtx throws)
- CTX-06 audit-row test confirms `_migrations.reads = Set(['Team'])` persists correctly after apply; second case confirms absent reads field when migration declares no reads
- CTX-08 rollback-refusal integration test confirms `EDBRollbackNotPossibleError(READS_DEPENDENCY_APPLIED)` is thrown with correct details and remediation message
- README §6.6 updated with eager-vs-lazy validation split paragraph and §6.6.5 error reference table covering all three Phase 6 error classes

## Task Commits

1. **Task 1: setupCtxTestTable helper + SC-5 four-cell matrix** - `0d80f38` (test)
2. **Task 2: CTX-06 audit-row + CTX-08 rollback-refusal integration tests** - `26bb2cd` (test + fix)
3. **Task 3: README §6.6 update** - `7ffa5e7` (docs)

## Files Created/Modified

- `tests/integration/ctx/_helpers.ts` - Factory `setupCtxTestTable({snapshotMode})` with matching/mismatched/absent modes; creates DDB Local table, seeds Team+User v1 records, writes Team snapshot to temp dir, returns cleanup hook
- `tests/integration/ctx/ctx-read.test.ts` - SC-5 four-cell matrix: four separate describe blocks, each with its own table lifecycle; cells 2+4 assert `EDBStaleEntityReadError` AND zero v2 records written
- `tests/integration/ctx/ctx-audit-row.test.ts` - CTX-06: reads field round-trip; CTX-bare: absent reads field round-trip
- `tests/integration/rollback/ctx08-refusal.test.ts` - CTX-08: three assertions (READS_DEPENDENCY_APPLIED details, EDBRollbackNotPossibleError type, remediation message)
- `src/rollback/preconditions.ts` - Bug fix: removed `.size > 0` guard that silently skipped CTX-08 check when DDB Local returns reads as Array
- `README.md` - Added eager/lazy validation paragraph and §6.6.5 Errors table with EDBSelfReadInMigrationError, EDBStaleEntityReadError, EDBRollbackNotPossibleError

## Decisions Made

- **Direct _migrations writes for CTX-08**: Running `client.apply()` for M-user then `client.apply()` for M-team left the lock in `release` state, causing `releaseIds.has is not a function` when rollback tried to inspect the lock. Redesigned setup to write `_migrations` rows directly via service bundle (same pattern as Phase 5 rollback integration tests).
- **normalizeReads() helper**: DDB Local returns ElectroDB `set` type attributes inconsistently (sometimes `Set`, sometimes `Array`, sometimes `{wrapperName:'Set', values:[]}` depending on SDK version and marshalling path). Added `normalizeReads()` defensive helper mirroring `apply-audit-row-shape.test.ts` pattern.
- **Inline undeclared migration for cells 3+4**: Rather than adding a new fixture file, defined `createUndeclaredReadsMigration` inline using the `ctx as { entity: ... } | undefined` cast pattern (per PATTERNS.md ctx typing guidance).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed CTX-08 precondition silently skipping when reads is Array**
- **Found during:** Task 2 (CTX-08 rollback-refusal integration test)
- **Issue:** `preconditions.ts` guard was `if (targetRow.reads !== undefined && targetRow.reads.size > 0)` — `Array.size` is `undefined` in JavaScript, so this evaluated to `false` whenever DDB Local returned the reads attribute as an Array instead of a Set. The CTX-08 check was silently skipped.
- **Fix:** Changed condition to `if (targetRow.reads !== undefined)`, letting `findBlockingReadsDependency` handle normalization via its existing `Array.isArray` + `new Set()` logic.
- **Files modified:** `src/rollback/preconditions.ts`
- **Verification:** Integration test CTX-08 now passes; 994 unit tests confirmed no regression
- **Committed in:** `26bb2cd` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug)
**Impact on plan:** Required for CTX-08 integration coverage. No scope creep; the fix is minimal (single condition line change).

## Issues Encountered

- **Worktree vs main repo path confusion**: Initial writes went to the main repo (`/Users/oliver/development/Repositories/open-source/electrodb-migrations/...`) rather than the worktree. Resolved by cherry-picking commits from main branch to worktree branch `worktree-agent-a6668084dbbead7f9`. The Task 1 and Task 2 test files were cherry-picked (`0d80f38` from main's `740d2a9`; `26bb2cd` from main's `c3a5131`). Task 3 README edit was committed directly in the worktree.
- **Lock state issue in CTX-08 first attempt**: `client.apply()` for M-user left lock in `release` state; rollback's `releaseIds.has()` failed because `releaseIds` was an Array. Redesigned to use direct service writes (Phase 5 pattern). See Decisions Made above.
- **Pre-existing finalize.test.ts failures**: Two pre-existing integration failures (DI-04-15-01/02) confirmed as pre-existing by running the suite before and after stashing changes. These are tracked known failures unrelated to Phase 6.

## Phase 6 Success Criteria Status

| SC | Requirement | Test | Status |
|----|-------------|------|--------|
| SC-1 | Cross-entity read works while lock held in apply state | `ctx-read.test.ts` Cells 1+3 | PASS |
| SC-2 | Writes through ctx throw before DDB | `ctx-write-trap.test.ts` (Plan 06-02 unit) | PASS |
| SC-3 | Self-read + stale-fingerprint throws | Cells 2+4 + ctx unit tests (Plans 06-03/04) | PASS |
| SC-4 | `_migrations.reads` round-trips | `ctx-audit-row.test.ts` CTX-06 | PASS |
| SC-5 | Four-cell matrix passes against DDB Local | `ctx-read.test.ts` all 4 cells | PASS |

All 5 Phase 6 success criteria satisfied.

## Integration Suite Baseline

- Unit suite: 994/994 passing
- Integration tests (Phase 6): 9/9 passing
- Integration tests (Phase 5 rollback): passing (no regression)
- Integration tests (Phase 4 runner): 2 pre-existing failures DI-04-15-01/02 remain (unrelated to Phase 6)

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 6 cross-entity reads is fully implemented and integration-tested
- All CTX-01..06 and CTX-08 requirements have integration coverage
- README §6.6 documents the shipped behavior (eager/lazy validation split, error classes, rollback ordering)
- Ready for `/gsd-verify-work` against ROADMAP Phase 6 success criteria
- Phase 7 (validate gate / CTX-07) can proceed; the `reads` field on `defineMigration` and the `_migrations.reads` audit row are both in place

---
*Phase: 06-cross-entity-reads*
*Completed: 2026-05-09*
