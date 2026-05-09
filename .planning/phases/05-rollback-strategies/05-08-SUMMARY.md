---
phase: 05-rollback-strategies
plan: 08
subsystem: rollback-case-1
tags:
  - rollback
  - case-1
  - tdd
  - phase-05
  - wave-2
  - rbk-03
dependency_graph:
  requires:
    - src/rollback/audit.ts (createRollbackAudit + RollbackAudit — Plan 05-04)
    - src/rollback/batch-flush-rollback.ts (batchFlushRollback — Plan 05-04)
    - src/safety/index.ts (CONSISTENT_READ — Phase 1)
    - tests/unit/rollback/_stub-service.ts (makeRollbackStubService — Plan 05-01)
  provides:
    - src/rollback/case-1-flow.ts (rollbackCase1 + RollbackCase1Args + RollbackCase1Result)
  affects:
    - src/rollback/index.ts (barrel extended with case-1-flow exports)
    - tests/unit/lock/source-scan.test.ts (no changes — invariants still pass with new src/rollback/ file)
tech_stack:
  added: []
  patterns:
    - RBK-03 lossless pre-release rollback by v2-delete (no down() required)
    - Cursor-based v2 scan mirroring iterateV1Records pattern from scan-pipeline.ts
    - Per-page batchFlushRollback flush (bounds memory at one page; complete withBatchWriteRetry cycle per page)
    - CONSISTENT_READ on every scan page (T-05-08-02 lock fence + source-scan invariant)
key_files:
  created:
    - src/rollback/case-1-flow.ts
    - tests/unit/rollback/case-1-flow.test.ts
  modified:
    - src/rollback/index.ts
decisions:
  - "Used `as never` for stub-to-production-type casts in test file — mirrors the established pattern in batch-flush-rollback.test.ts (avoid complex Parameters<typeof fn>[0] cast that TypeScript TS2352 rejects)"
  - "Per-page flush (one batchFlushRollback call per scan page) chosen over accumulate-all-then-flush — bounds memory at one page (default 100 records) while keeping each page as a complete withBatchWriteRetry retry cycle (PATTERNS.md line 449)"
  - "migration.down is intentionally NEVER accessed — confirmed by grep invariant (acceptance criteria) and by using hasDown:false stub which leaves migration.down===undefined; the no-down test proves the lossless property"
metrics:
  duration_minutes: 4
  completed_date: "2026-05-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 1
---

# Phase 5 Plan 08: Case 1 (Pre-Release) Rollback Flow Summary

TDD landing of `rollbackCase1` — the lossless pre-release rollback path per RBK-03. Deletes every v2 record via cursor-based scan + per-page `batchFlushRollback`; v1 records are never touched; `migration.down` is never accessed.

## What Was Built

### `rollbackCase1` (RBK-03)

`src/rollback/case-1-flow.ts` — Case 1 pre-release rollback flow:

- **Cursor-based v2 scan:** `migration.to.scan.go({cursor, limit, consistent: CONSISTENT_READ})` — mirrors the `iterateV1Records` pattern from `src/runner/scan-pipeline.ts:42-63` but targets `migration.to` (v2 entity).
- **Per-page flush:** `batchFlushRollback({migration, client, tableName, v2Deletes: page})` called once per non-empty scan page. Bounds memory at one page (default 100 records).
- **Audit instrumentation:** `audit.incrementScanned()` per record + `audit.addDeleted(result.written)` per page flush.
- **`migration.down` is NEVER accessed** — lossless property: v1 records are intact; deletion of v2 restores the table to pre-apply state without needing a reverse transform.
- **Exports:** `rollbackCase1`, `RollbackCase1Args`, `RollbackCase1Result` — all re-exported from `src/rollback/index.ts`.

### Test Coverage (10 cases)

| Test | Property Verified |
|------|-------------------|
| Empty v2 scan | No batch flush; all audit counts zero; invariant holds |
| 5 records, 1 page | Batch flush called once; scanned=5, deleted=5 |
| 30 records, 2 pages (25+5) | Batch flush called twice; scanned=30, deleted=30 |
| 100 records, 4 pages of 25 | Batch flush called 4 times; scanned=100, deleted=100 |
| No `down` function (hasDown:false stub) | rollback succeeds; migration.down===undefined confirmed |
| CONSISTENT_READ | Every v2 scan op has `opts.consistent === true` |
| Default page size | First scan call `opts.limit === 100` |
| Custom page size 25 | First scan call `opts.limit === 25` |
| batchFlushRollback throw propagates | Partial scan counts; no swallow; rejects.toThrow confirmed |
| Return shape | Returns defined object on success |

## RBK Requirement Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| RBK-03 | Unit-tested | 10 test cases covering all pagination cells + no-down fixture + throw propagation |

## `migration.down` Never Accessed

Confirmed by two independent mechanisms:
1. **Source grep:** `grep "migration\.down(" src/rollback/case-1-flow.ts` returns 0 matches (acceptance criteria grep invariant).
2. **Test fixture:** The `hasDown: false` stub leaves `migration.down === undefined`; the test explicitly asserts `expect(migration.down).toBeUndefined()` and confirms `rollbackCase1` succeeds. If the implementation had tried to call `migration.down()`, it would have thrown `TypeError: migration.down is not a function`.

## Source-Scan Invariants

`pnpm vitest run tests/unit/lock/source-scan.test.ts` — 3/3 PASS after adding `src/rollback/case-1-flow.ts`:
- The new file imports `CONSISTENT_READ` from `'../safety/index.js'` (named import — no inline `consistent: true`).
- No `setInterval` in the new file.
- No `migrationState.get(` calls in the new file (not needed for Case 1).

## Test Results

| File | Tests | Result |
|------|-------|--------|
| tests/unit/rollback/case-1-flow.test.ts | 10 | PASS |
| tests/unit/lock/source-scan.test.ts | 3 | PASS |
| `pnpm tsc --noEmit` | — | PASS (0 errors) |

## TDD Gate Compliance

1. `test(05-08): RED — failing tests for rollbackCase1 across page-count cells` (62d6191) → tests failed (import target missing)
2. `feat(05-08): GREEN — pre-release rollback per RBK-03` (fda8d20) → all 10 tests pass

RED → GREEN cycle complete. No REFACTOR needed — the cursor loop is only used in this one module in Phase 5 (PLAN explicitly deferred `iterateV2Records` extraction).

## Commits

| Task | Hash | Description |
|------|------|-------------|
| RED | 62d6191 | test(05-08): RED — failing tests for rollbackCase1 across page-count cells |
| GREEN | fda8d20 | feat(05-08): GREEN — pre-release rollback per RBK-03 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript TS2352 errors on stub-to-production-type casts**

- **Found during:** GREEN — `pnpm tsc --noEmit` after implementation
- **Issue:** Test file used `migration as Parameters<typeof rollbackCase1>[0]['migration']` which TypeScript TS2352 rejects as "neither type sufficiently overlaps" when the stub lacks ElectroDB Entity methods (`schema`, `get`, `remove`, etc.). This is the same structural mismatch that exists in all other rollback tests.
- **Fix:** Replaced all stub casts with `as never` — the same pattern already established in `batch-flush-rollback.test.ts` (which uses `migration as never` and `client as never`). TypeScript accepts `T as never` as a bypass for structural mismatch in test files.
- **Files modified:** `tests/unit/rollback/case-1-flow.test.ts`
- **Commit:** fda8d20 (included in GREEN commit)

## Known Stubs

None. `rollbackCase1` is fully implemented, not a stub.

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. T-05-08-02 (DATA-LOSS race with in-flight app writes) is mitigated by `consistent: CONSISTENT_READ` on every scan page — confirmed by both the source-scan invariant test and the per-test `consistent === true` assertion.

## Self-Check: PASSED

- `src/rollback/case-1-flow.ts` exists: FOUND
- `tests/unit/rollback/case-1-flow.test.ts` exists: FOUND
- `src/rollback/index.ts` re-exports `rollbackCase1`: FOUND
- RED commit `62d6191` in git log: FOUND
- GREEN commit `fda8d20` in git log: FOUND
- 10 tests pass, 3 source-scan tests pass, `tsc --noEmit` clean: CONFIRMED
