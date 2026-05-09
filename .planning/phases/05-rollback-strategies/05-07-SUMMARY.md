---
phase: 05-rollback-strategies
plan: 07
subsystem: rollback-strategies-custom
tags:
  - rollback
  - strategies
  - custom
  - resolver
  - tdd
  - phase-05
  - wave-2
  - rbk-08
dependency_graph:
  requires:
    - src/rollback/resolver-validate.ts (validateResolverResult — Plan 05-04)
    - src/rollback/batch-flush-rollback.ts (batchFlushRollback — Plan 05-04)
    - src/rollback/audit.ts (RollbackAudit — Plan 05-04)
    - src/rollback/type-table.ts (TypeTableEntry — Plan 05-03)
    - tests/_helpers/sample-migrations/User-add-status-with-resolver (Plan 05-01)
  provides:
    - src/rollback/strategies/custom.ts (executeCustom + ExecuteCustomArgs)
    - src/migrations/types.ts (RollbackResolverArgs + tightened rollbackResolver field)
  affects:
    - src/rollback/index.ts (barrel: executeCustom + ExecuteCustomArgs + RollbackResolverArgs)
    - src/migrations/index.ts (re-exports RollbackResolverArgs)
    - tests/unit/migrations/define.test.ts (updated rollbackResolver stub to async)
    - tests/integration/runner/apply-audit-row-shape.test.ts (updated type annotations)
tech_stack:
  added: []
  patterns:
    - Per-record resolver dispatch with three-way result routing (put/v1Delete/skip-B)
    - Pitfall 3 mitigation (validateResolverResult wraps ElectroDB schema validation)
    - Fail-fast with audit.incrementFailed() + rethrow on resolver throw or validation throw
    - undefined → null normalization (additive widening for resolver authors)
    - buildResolverArgs helper: field-conditional construction per TypeTableEntry type
    - as never double cast pattern for stub objects in TypeScript strict tests
key_files:
  created:
    - src/rollback/strategies/custom.ts
    - tests/unit/rollback/strategies/custom.test.ts
    - tests/unit/migrations/types.test-d.ts
  modified:
    - src/migrations/types.ts (add RollbackResolverArgs, tighten rollbackResolver)
    - src/migrations/index.ts (re-export RollbackResolverArgs)
    - src/rollback/index.ts (barrel: executeCustom + ExecuteCustomArgs + RollbackResolverArgs)
    - tests/unit/migrations/define.test.ts (rollbackResolver stub async update)
    - tests/integration/runner/apply-audit-row-shape.test.ts (type annotation updates)
decisions:
  - "buildResolverArgs extracted as private helper vs. inline spread — Plan 05-07 impl section recommended this refactor; extracted to keep per-type field-conditional logic readable and testable by assertion on spy.mock.calls[0][0] shape"
  - "as never double cast for makeMigration/client stubs in test file — mirrors established pattern from batch-flush-rollback.test.ts; avoids maintaining 15+ individual as ExecuteCustomArgs[...] casts"
  - "undefined → null normalization done BEFORE validateResolverResult call — keeps validateResolverResult's null path clean and documents the additive widening at the strategy layer"
  - "OQ7 disposition: RollbackResolverArgs is additive widening from Phase 2 placeholder — existing resolver fixtures (args: unknown) compile unchanged (function parameter contravariance)"
metrics:
  duration_minutes: 18
  completed_date: "2026-05-09"
  tasks_completed: 4
  tasks_total: 4
  files_created: 3
  files_modified: 5
---

# Phase 5 Plan 07: Custom Strategy Executor (RBK-08) + Resolver Type Tightening Summary

TDD landing of `executeCustom` — per-record resolver dispatch via user-supplied `rollbackResolver` with `validateResolverResult` Pitfall 3 mitigation — plus additive tightening of the `rollbackResolver` type signature from the Phase 2 opaque `(...args: unknown[]) => unknown` to the specific `(args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>`.

## What Was Built

### Sub-feature A: `RollbackResolverArgs` + Type Tightening (RBK-08 / RESEARCH OQ7)

`src/migrations/types.ts` — New `RollbackResolverArgs` interface exported and documented with full JSDoc table showing which fields are present per type (A/B/C). The `rollbackResolver` field on `Migration<From, To>` is now typed as:

```typescript
rollbackResolver?: (args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>;
```

`src/migrations/index.ts` — Re-exports `RollbackResolverArgs` for users authoring `defineMigration({rollbackResolver: ...})`.

**Additive widening verified:** The existing `User-add-status-with-resolver` fixture uses `(args: unknown)` which is assignable to `(args: RollbackResolverArgs)` via function parameter contravariance. `pnpm tsc --noEmit` exits 0 without modifying the fixture.

**OQ7 disposition resolved:** The RESEARCH OQ7 open question (whether to tighten now vs. Phase 8) is resolved: tighten now as an additive widening. Existing code compiles; new resolvers get full autocomplete. Decision is closed.

### Sub-feature B: `executeCustom` Strategy Executor (RBK-08)

`src/rollback/strategies/custom.ts` — Per-record dispatch implementation:

**Per-type action table (RESEARCH §Section 4 lines 1208-1219):**

| Type | resolver result | Action                                             | Audit     |
|------|-----------------|----------------------------------------------------|-----------|
| A    | null/undefined  | `v1Deletes.push(v1Original)` — delete v1 mirror    | deleted++ |
| A    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++|
| B    | null/undefined  | no-op (v1 doesn't exist for B; skip B null)        | skipped++ |
| B    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++|
| C    | null/undefined  | `v1Deletes.push(v1Original)` — delete v1 mirror    | deleted++ |
| C    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++|

Key implementation details:
- `buildResolverArgs(entry, migration.down)` — private helper that conditionally includes `v1Original`, `v2`, and `down` based on entry type (only fields valid for the type are passed)
- Resolver throw → `audit.incrementFailed()` + rethrow (fail-fast)
- `undefined` normalized to `null` before `validateResolverResult` (additive widening)
- `validateResolverResult` throw → `audit.incrementFailed()` + rethrow with `domainKey` context preserved (Pitfall 3 / T-05-07-01)
- Type B + null → `audit.incrementSkipped()` (v1 doesn't exist for B; "delete null" is a no-op)
- Defensive `!resolver` guard throws explicitly rather than no-op

**Barrel exports (`src/rollback/index.ts`):**
- `executeCustom`, `type ExecuteCustomArgs` from `./strategies/custom.js`
- `type RollbackResolverArgs` re-exported from `../migrations/types.js`

### Test Coverage: 13 Cases (custom.test.ts)

| # | Case | Result |
|---|------|--------|
| 1 | Empty classifier | Audit zeros, resolver not called |
| 2 | 5 Type A + returns v1Original | audit.reverted=5 |
| 3 | 5 Type B + down(v2) | audit.reverted=5 |
| 4 | 3 Type C + returns null | audit.deleted=3 |
| 5 | Mixed 2A+2B+2C | reverted=4, deleted=2, skipped=0 |
| 6 | 1 Type B + null | audit.skipped=1 |
| 7 | 1 Type A, resolver throws | audit.failed=1, error bubbles, no batch flush |
| 8 | 1 Type A, v2-shape (name:42) | validateResolverResult throws with domainKey, audit.failed=1 |
| 9 | 1 Type A, resolver returns undefined | treated as null → v1Delete, deleted=1 |
| 10 | 1 Type A, resolver returns string | validateResolverResult throws, audit.failed=1 |
| 11 | Resolver args shape for type A | kind/v1Original/v2/down all present |
| 12 | Type B: v1Original absent | `callArgs.v1Original === undefined` |
| 13 | Type C: v2 absent | `callArgs.v2 === undefined` |

### Type Test: `tests/unit/migrations/types.test-d.ts`

Compile-time assertion that:
- `RollbackResolverArgs` has `kind`, `v1Original`, `v2`, `down` properties
- `Migration<any,any>['rollbackResolver']` parameter matches `RollbackResolverArgs`
- Return type matches `Promise<Record<string, unknown> | null | undefined>`

## RBK Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| RBK-08 | Unit-tested (full) | `executeCustom` + 13 test cases + Pitfall 3 validation (Case 8) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript cast errors in test file — stubs don't satisfy Migration/DynamoDBDocumentClient shape**

- **Found during:** GREEN — `pnpm tsc --noEmit` after implementing `executeCustom`
- **Issue:** Test file used `as ExecuteCustomArgs['migration']` casts which TypeScript rejected because the stub entity from `makeRollbackStubService` doesn't implement all 17 ElectroDB `Entity<>` properties (only the duck-typed subset needed by rollback). Same for `DynamoDBDocumentClient`.
- **Fix:** Changed all casts to `as never` — the established pattern in `batch-flush-rollback.test.ts`. Also changed `realMigration as Record<string, unknown>` to `realMigration as unknown as Record<string, unknown>` for the rollbackResolver override.
- **Files modified:** `tests/unit/rollback/strategies/custom.test.ts`
- **Commit:** 77ec6bc (included in GREEN)

**2. [Rule 2 - Missing] Existing tests used old rollbackResolver type**

- **Found during:** GREEN (sub-feature A) — `pnpm tsc --noEmit` revealed two test files using the old loose type
- **Issue:**
  - `tests/unit/migrations/define.test.ts` had `rollbackResolver: () => 'projected'` (sync, returns string)
  - `tests/integration/runner/apply-audit-row-shape.test.ts` had `rollbackResolver?: (...args: unknown[]) => unknown` in interface + sync `() => null` in test case
- **Fix:**
  - Updated `define.test.ts` to `async (_args) => null`
  - Updated `apply-audit-row-shape.test.ts`: imported `RollbackResolverArgs`, updated type annotation, changed resolver to `async (_args: RollbackResolverArgs) => null`
- **Files modified:** `tests/unit/migrations/define.test.ts`, `tests/integration/runner/apply-audit-row-shape.test.ts`
- **Commit:** 58b8caf (part of sub-feature A feat commit)

## TDD Gate Compliance

All three TDD cycles were completed:

1. **Sub-feature A (type tightening):**
   - `test(05-07): RED — type test for RollbackResolverArgs and tightened rollbackResolver signature` → verified failing via `pnpm tsc --noEmit` (TS2305: no exported member 'RollbackResolverArgs')
   - `feat(05-07): tighten rollbackResolver signature per RESEARCH OQ7 (RBK-08)` → GREEN

2. **Sub-feature B (executeCustom):**
   - `test(05-07): RED — failing tests for executeCustom across (type x result) cells` → verified failing (module not found)
   - `feat(05-07): GREEN — custom strategy executor per RBK-08` → GREEN

No REFACTOR commits were needed — `buildResolverArgs` was extracted inline during GREEN.

## Known Stubs

None. All production modules are fully implemented.

## Self-Check: PASSED

- `src/rollback/strategies/custom.ts` — FOUND
- `tests/unit/rollback/strategies/custom.test.ts` — FOUND (13/13 tests pass)
- `tests/unit/migrations/types.test-d.ts` — FOUND
- `.planning/phases/05-rollback-strategies/05-07-SUMMARY.md` — FOUND
- Commits d518064, 58b8caf, a7580d6, 77ec6bc — all in git log
- `pnpm tsc --noEmit` — PASS (0 errors)

## Commits

| Task | Hash | Description |
|------|------|-------------|
| RED (type test) | d518064 | test(05-07): RED — type test for RollbackResolverArgs |
| GREEN (type tightening) | 58b8caf | feat(05-07): tighten rollbackResolver signature per RESEARCH OQ7 |
| RED (executeCustom) | a7580d6 | test(05-07): RED — failing tests for executeCustom |
| GREEN (executeCustom) | 77ec6bc | feat(05-07): GREEN — custom strategy executor per RBK-08 |

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`:
- T-05-07-01 (Pitfall 3 DATA-LOSS): mitigated by `validateResolverResult` wrapping ElectroDB schema validation; Case 8 test pins v2-shape rejection
- T-05-07-02 (resolver throws mid-loop): mitigated by `audit.incrementFailed()` + rethrow; Case 7 test pins
- T-05-07-03 (missing required v1 attrs): same `validateResolverResult` mitigation as T-05-07-01
- T-05-07-05 (resolver escape via down): mitigated — resolver args are intentionally minimal (kind/v1Original/v2/down ref only)
