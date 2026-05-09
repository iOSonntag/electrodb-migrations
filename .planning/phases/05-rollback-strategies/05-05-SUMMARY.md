---
phase: 05-rollback-strategies
plan: 05
subsystem: rollback
tags:
  - rollback
  - strategies
  - tdd
  - phase-05
  - wave-2
  - rbk-05
  - rbk-07
dependency_graph:
  requires:
    - src/rollback/type-table.ts (TypeTableEntry — Plan 05-03)
    - src/rollback/audit.ts (RollbackAudit — Plan 05-04)
    - src/rollback/batch-flush-rollback.ts (batchFlushRollback — Plan 05-04)
    - tests/unit/rollback/_stub-service.ts (makeRollbackStubService — Plan 05-01)
  provides:
    - src/rollback/strategies/projected.ts (executeProjected — RBK-05)
    - src/rollback/strategies/fill-only.ts (executeFillOnly — RBK-07)
    - src/rollback/index.ts (barrel updated with both strategy exports)
    - tests/unit/rollback/strategies/projected.test.ts (9 cases)
    - tests/unit/rollback/strategies/fill-only.test.ts (5 cases)
  affects:
    - 05-09 (orchestrator — dispatches to executeProjected / executeFillOnly by strategy flag)
tech_stack:
  added: []
  patterns:
    - ExecuteStrategyArgs shared interface (both strategies expose identical signature)
    - down-throw bubble pattern (audit.incrementFailed() + rethrow, mirrors apply-flow RUN-08)
    - OQ-2 mirror (down returning null/undefined → incrementSkipped, no v1 written)
    - Accumulate-then-flush (all puts/v1Deletes buffered before single batchFlushRollback call)
    - fill-only conditional flush (batchFlushRollback skipped when puts.length === 0)
key_files:
  created:
    - src/rollback/strategies/projected.ts
    - src/rollback/strategies/fill-only.ts
    - tests/unit/rollback/strategies/projected.test.ts
    - tests/unit/rollback/strategies/fill-only.test.ts
  modified:
    - src/rollback/index.ts
key_decisions:
  - "ExecuteStrategyArgs is defined in projected.ts and re-exported from fill-only.ts — single source of truth for the shared strategy signature; Plan 05-09 orchestrator imports from either file"
  - "fill-only skips batchFlushRollback when puts.length === 0 (no type B entries) — avoids an unnecessary DDB call on all-A/C datasets; projected always calls batchFlushRollback to handle the v1Deletes path even on empty puts"
  - "Type D is unreachable per classifier construction (RESEARCH §Section 3 line 1097) — no defensive branch added; comment documents this invariant"
requirements-completed:
  - RBK-05
  - RBK-07

# Metrics
duration: 4min
completed: "2026-05-09"
---

# Phase 5 Plan 05: Strategy Executors — projected (RBK-05) + fill-only (RBK-07) Summary

**TDD landing of two down-requiring rollback strategy executors — `projected` (default; derives v1 for all A/B, deletes v1 mirror for C) and `fill-only` (keeps A/C, derives v1 only for B) — consuming the type-table classifier and heterogeneous batch flush from Wave 1.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-09T12:40:00Z
- **Completed:** 2026-05-09T12:43:00Z
- **Tasks:** 5 (RED projected, GREEN projected, RED fill-only, GREEN fill-only, barrel update)
- **Files created:** 4 src+test; **Files modified:** 1 (barrel)

## Accomplishments

- `executeProjected` (RBK-05): per-type dispatch — A/B→`down(v2)`→put; C→delete v1 mirror. Down-throw increments `audit.failed` and rethrows. Null/undefined from `down` increments `audit.skipped`. 9 unit test cases including empty, multi-type mix, down-throw, null-return, verbatim-v2-arg assertion.
- `executeFillOnly` (RBK-07): per-type dispatch — A/C→`incrementSkipped()`; B→`down(v2)`→put. Batch flush conditional on `puts.length > 0`. 5 unit test cases including empty, A-only, A+B+C mix, down-throw, type A/C never invoke down assertion.
- Both strategies share `ExecuteStrategyArgs` interface; barrel `src/rollback/index.ts` exports both.

## Per-Type Action Tables

### `projected` (RBK-05; RESEARCH §Section 4 lines 1180-1186)

| Type | Action | Audit increment |
|------|--------|-----------------|
| A | `v1Derived = await down(v2)` → `puts.push(v1Derived)` | `addReverted(1)` after batch flush |
| B | `v1Derived = await down(v2)` → `puts.push(v1Derived)` | `addReverted(1)` after batch flush |
| C | `v1Deletes.push(entry.v1Original!)` (delete v1 mirror — honors app-side delete) | `addDeleted(1)` after batch flush |

### `fill-only` (RBK-07; RESEARCH §Section 4 lines 1200-1207)

| Type | Action | Audit increment |
|------|--------|-----------------|
| A | KEEP — no DDB write | `incrementSkipped()` |
| B | `v1Derived = await down(v2)` → `puts.push(v1Derived)` | `addReverted(1)` after batch flush |
| C | KEEP — no DDB write | `incrementSkipped()` |

## Task Commits

| Task | Hash | Description |
|------|------|-------------|
| RED (projected) | d753bc7 | test(05-05): RED — failing tests for executeProjected |
| GREEN (projected) | 2d87017 | feat(05-05): GREEN — projected strategy per RBK-05 |
| RED (fill-only) | 71ff5f5 | test(05-05): RED — failing tests for executeFillOnly |
| GREEN (fill-only) | f77940f | feat(05-05): GREEN — fill-only strategy per RBK-07 |
| Barrel update | 51547a0 | feat(05-05): barrel update — re-export executeProjected + executeFillOnly |

## Files Created/Modified

- `src/rollback/strategies/projected.ts` — `executeProjected` function + `ExecuteStrategyArgs` interface (RBK-05)
- `src/rollback/strategies/fill-only.ts` — `executeFillOnly` function (RBK-07)
- `tests/unit/rollback/strategies/projected.test.ts` — 9 unit test cases (RED→GREEN TDD)
- `tests/unit/rollback/strategies/fill-only.test.ts` — 5 unit test cases (RED→GREEN TDD)
- `src/rollback/index.ts` — Added Wave 2 strategy exports

## Decisions Made

- **ExecuteStrategyArgs defined in projected.ts, re-exported from fill-only.ts.** Avoids duplication while keeping `fill-only.ts` self-contained. Plan 05-09 can import `ExecuteStrategyArgs` from either module.
- **fill-only skips batchFlushRollback when `puts.length === 0`.** No-op on all-A/C datasets. The `projected` strategy always calls `batchFlushRollback` (to support the v1Deletes path).
- **No REFACTOR phase needed.** Both implementations are already minimal (~97 LOC src each). The shared duplication is structural (for-await loop + audit increments) and extracting a helper would add noise without reducing lines.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test imports used wrong relative paths**

- **Found during:** GREEN phase for projected — tests failed with "file not found" error
- **Issue:** The plan's test snippet used `../../rollback/strategies/projected.js` as the import path, but the test file lives in `tests/unit/rollback/strategies/` (4 levels from `src/`). Other rollback tests in `tests/unit/rollback/` use `../../../src/rollback/...`. The correct relative path from `tests/unit/rollback/strategies/` is `../../../../src/rollback/strategies/...`.
- **Fix:** Updated import paths in both test files to use `../../../../src/rollback/...` and `../../../src/rollback/...` for stub-service.
- **Files modified:** `tests/unit/rollback/strategies/projected.test.ts`, `tests/unit/rollback/strategies/fill-only.test.ts`
- **Commit:** 2d87017 (included in GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — import path error)
**Impact on plan:** Necessary correctness fix. No scope creep.

## Test Results

| File | Tests | Result |
|------|-------|--------|
| tests/unit/rollback/strategies/projected.test.ts | 9 | PASS |
| tests/unit/rollback/strategies/fill-only.test.ts | 5 | PASS |
| All other tests/unit/rollback/ | 82 | PASS |
| tests/unit/lock/source-scan.test.ts | 3 | PASS |
| `pnpm tsc --noEmit` | — | PASS (0 errors) |

**Source-scan invariants (CONSISTENT_READ, no setInterval, no inline `consistent: true`) still pass.** The strategy files do not call any scan methods directly — they consume a pre-built `AsyncGenerator<TypeTableEntry>` — so no new invariant surface was added.

## Requirement Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| RBK-05 (projected strategy) | Unit-tested | 9 cases covering all type-dispatch paths, down-throw, null-return, verbatim-v2-arg |
| RBK-07 (fill-only strategy) | Unit-tested | 5 cases covering all type-dispatch paths, down-throw, A/C-never-call-down |

## Known Stubs

None. Both production modules are fully implemented.

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. T-05-05-01 (down throw mid-loop) and T-05-05-02 (down returns v2-shape) are both defended:
- T-05-05-01: `try/catch` around `down(v2)` → `incrementFailed()` → rethrow in both strategies
- T-05-05-02: `batchFlushRollback` invokes `migration.from.put(record).params()` for schema validation before any DDB send (Plan 05-04 mitigates this at the flush layer)

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (projected) | d753bc7 | PASS — import failure confirms test was failing |
| GREEN (projected) | 2d87017 | PASS — 9/9 tests pass |
| RED (fill-only) | 71ff5f5 | PASS — import failure confirms test was failing |
| GREEN (fill-only) | f77940f | PASS — 5/5 tests pass |

No REFACTOR commits — both implementations are already minimal. The plan explicitly stated "none expected" for REFACTOR.

## Self-Check: PASSED
