# Phase 04 — Deferred Items

Out-of-scope discoveries logged during plan execution. Per the executor's
SCOPE BOUNDARY rule, only issues directly caused by the current task's changes
are auto-fixed; everything else is logged here for a follow-up plan.

## Logged during 04-15 execution (2026-05-09)

### DI-04-15-01 — `tests/integration/runner/finalize.test.ts` fails against current main

- **Symptom:** `expect(finResult.finalized[0]!.itemCounts.migrated).toBe(100)` at
  `tests/integration/runner/finalize.test.ts:80` fails — `migrated` is 0 (or
  undefined). The fix in commit `e22e35d` (WR-05) added a separate `deleted`
  slot to `ItemCounts` for finalize counts, but the test was not updated to
  read `itemCounts.deleted` instead of `itemCounts.migrated`.
- **Reproduction:** `pnpm vitest run --config vitest.integration.config.ts tests/integration/runner/finalize.test.ts`
  fails 1/1 in isolation, with NO unrelated test files modified
  (`git status` shows only the new 04-15 file).
- **Out of scope for 04-15:** This plan is a regression-test backfill for the
  apply-flow audit row. The finalize test's assertion semantics drift is
  unrelated and predates this plan's branch base
  (`f8f8405 fix(04): WR-09/WR-10 follow-up`).
- **Recommended fix (one-liner):** `expect(finResult.finalized[0]!.itemCounts.deleted).toBe(100)`.
- **Tracker:** track via Phase 04 review-fix follow-up; not a Phase 5 blocker.

### DI-04-15-02 — `tests/integration/runner/guarded-write-at-boundary.test.ts` fails when run as part of the full integration suite

- **Symptom:** `expect(successes).toHaveLength(0)` at
  `tests/integration/runner/guarded-write-at-boundary.test.ts:191` fails with
  `Received 2`. Two of the 20 guarded writes succeed (instead of all 20 failing
  with `EDBMigrationInProgressError`).
- **Reproduction:** `pnpm vitest run --config vitest.integration.config.ts`
  reproduces the failure consistently. Running the file in tighter isolation
  (`pnpm vitest run … tests/integration/runner/guarded-write-at-boundary.test.ts
  tests/integration/runner/finalize.test.ts`) also reproduces it. Running the
  file completely alone (`… guarded-write-at-boundary.test.ts`) PASSES — so
  this looks like state-leak between integration tests sharing DDB Local
  containers (lock-row residue, guard-cache TTL crossover, or sibling-table
  retention from earlier suites).
- **Out of scope for 04-15:** No source under `src/` was modified by this plan;
  the test file itself was not modified by this plan; the failure exists on
  the same base commit (`f8f8405`) before the new file was added.
- **Recommended fix:** investigate test isolation — likely needs
  per-suite table cleanup ordering or guard-cache reset hooks. Distinct
  problem from the BL-01 audit-row gap closure.
- **Tracker:** track via Phase 04 review-fix follow-up; consider as part of a
  broader integration-test isolation cleanup pass.

## Notes

- 04-15's own test file (`tests/integration/runner/apply-audit-row-shape.test.ts`)
  passes 2/2 in every configuration:
  - Alone: 2/2 in 1.7s.
  - Inside the full integration run: 2/2 (the failures above are in unrelated
    files).
- `pnpm typecheck` and `pnpm check` (Biome) are clean.
- 60/60 baseline → 62/62 NEW pass total inside the integration suite, AT THE
  SAME FAILURE COUNT as before this plan ran (i.e., 04-15 introduced ZERO new
  failures).
