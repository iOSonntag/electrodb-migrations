---
phase: 05-rollback-strategies
plan: 02
subsystem: rollback-preconditions
tags:
  - rollback
  - preconditions
  - tdd
  - phase-05
  - wave-1
  - rbk-01
  - rbk-09
  - rbk-10
dependency_graph:
  requires:
    - tests/unit/rollback/_stub-service.ts (Plan 05-01)
    - src/errors/classes.ts (Phase 1)
    - src/errors/codes.ts (Phase 1)
    - src/lock/read-lock-row.ts (Phase 4)
    - src/internal-entities/service.ts (Phase 2)
    - src/migrations/types.ts (Phase 2)
  provides:
    - src/rollback/preconditions.ts (checkPreconditions, RollbackDecision, CheckPreconditionsArgs)
    - src/rollback/lifecycle-case.ts (determineLifecycleCase)
    - src/rollback/head-only.ts (findHeadViolation, MigrationsRow)
    - src/rollback/index.ts (barrel)
  affects:
    - tests/unit/lock/source-scan.test.ts (src/rollback/ assertion flipped false→true)
tech_stack:
  added: []
  patterns:
    - Pure-function TDD (RED→GREEN per feature before next RED)
    - Discriminated-union RollbackDecision with kind:'proceed'|'refuse'
    - Plain Error + .code duck-typing for framework-internal refusal codes
    - Post-construction .remediation property assignment on EDB* errors
    - Case 1 short-circuit before strategy/capability checks
key_files:
  created:
    - src/rollback/lifecycle-case.ts
    - src/rollback/head-only.ts
    - src/rollback/preconditions.ts
    - src/rollback/index.ts
    - tests/unit/rollback/lifecycle-case.test.ts
    - tests/unit/rollback/head-only.test.ts
    - tests/unit/rollback/preconditions.test.ts
  modified:
    - tests/unit/lock/source-scan.test.ts
decisions:
  - "Case 1 short-circuits BEFORE strategy/capability checks: RESEARCH §Section 1 states 'strategy is recorded but the action is identical for Case 1' — down() is not required. Adding a guard at the top of the Case 1 branch avoids false NO_DOWN_FUNCTION refusals for failed-status migrations without down()."
  - "MigrationsRow interface defined in head-only.ts and re-exported from index.ts — kept co-located with its consumer function rather than adding a new types.ts file in the rollback directory (no other plans need it as a standalone import)."
  - "source-scan assertion updated: the Plan 05-01 placeholder assertion expect(files.some(f => f.includes('src/rollback/'))).toBe(false) was flipped to .toBe(true) because Plan 05-02 creates the first src/rollback/ file."
metrics:
  duration_minutes: 25
  completed_date: "2026-05-09"
  tasks_completed: 3
  tasks_total: 3
  files_created: 7
  files_modified: 1
---

# Phase 5 Plan 02: Rollback Preconditions + Pure Helpers (RBK-01/09/10) Summary

TDD landing of three pure/I-O-fronted rollback functions: `determineLifecycleCase` (status×lock→case), `findHeadViolation` (RBK-01 head-only rule), and `checkPreconditions` (10-step I/O dispatcher composing both) — plus a strict-named-export barrel.

## What Was Built

### Feature 1: `determineLifecycleCase` (src/rollback/lifecycle-case.ts)
Pure function mapping `(_migrations.status × lockRow × migId)` to `'case-1' | 'case-2' | 'case-3'`:
- **Case 1**: `status ∈ {pending, failed}` OR `status='applied' AND lockState='release' AND releaseIds.has(migId)`.
- **Case 2**: `status='applied'` AND not Case 1.
- **Case 3**: `status='finalized'`.
- Defensive throw on `status='reverted'` (filtered upstream by `checkPreconditions`).
- `isReleaseModeForMig()` extracted as internal predicate.
- 9 parameterized test cases (all truth-table cells including reverted throw).

### Feature 2: `findHeadViolation` (src/rollback/head-only.ts)
Pure function returning the first later-sequenced `applied`/`finalized` row for the same entity, or `undefined`:
- Implements verbatim spec from RESEARCH §Code Examples lines 880-888.
- Uses `Number.parseInt(toVersion, 10)` for numeric comparison (prevents `'9' > '10'` lexicographic bug).
- Exports `MigrationsRow` interface used by `checkPreconditions`.
- 9 parameterized test cases including cross-entity isolation and the numeric-comparison pin.

### Feature 3: `checkPreconditions` (src/rollback/preconditions.ts)
10-step I/O-fronted dispatcher:
1. Full `_migrations` scan (`pages: 'all'`).
2. `EDB_MIGRATION_NOT_FOUND` if target absent.
3. `EDB_ALREADY_REVERTED` if `status='reverted'` (plain Error + `.code`).
4. `EDB_NOT_APPLIED` if `status='pending'` (plain Error + `.code`).
5. `EDBRollbackOutOfOrderError` via `findHeadViolation` (RBK-01).
6. Read lock row via `readLockRow(service)`.
7. Determine lifecycle case via `determineLifecycleCase`.
8. **Case 1 short-circuit**: proceed immediately (no strategy/capability checks apply).
9. `FINALIZED_ONLY_PROJECTED` if Case 3 + `snapshot`/`fill-only`.
10. `NO_DOWN_FUNCTION` if `projected`/`fill-only` + no `down()`.
11. `NO_RESOLVER` if `custom` + no `rollbackResolver`.
12. Return `{ kind: 'proceed', case, targetRow }`.

Every refusal error has a `.remediation` string attached post-construction. 20 parameterized test cases.

### Barrel: `src/rollback/index.ts`
Explicit named re-exports only — no `export *`:
```typescript
export { checkPreconditions, type RollbackDecision, type CheckPreconditionsArgs } from './preconditions.js';
export { determineLifecycleCase } from './lifecycle-case.js';
export { findHeadViolation, type MigrationsRow } from './head-only.js';
```

## RBK Requirement Coverage

| Requirement | Description | Status |
|---|---|---|
| **RBK-01** | Head-only rule: refuse rollback when a newer applied/finalized migration exists for same entity | Covered by `findHeadViolation` + `preconditions.test.ts` head-violation test case |
| **RBK-09** | Post-finalize strategy restrictions: `snapshot`/`fill-only` refuse on Case 3 | Covered by FINALIZED_ONLY_PROJECTED refusal path + 2 test cases |
| **RBK-10** | Reason-code error surface: `NO_DOWN_FUNCTION`, `NO_RESOLVER`, `FINALIZED_ONLY_PROJECTED` | Covered by capability checks + all 7 refusal string literals in test assertions |

## Truth-Table Cell Coverage (preconditions.test.ts)

| Lifecycle Case | Strategy | hasDown | hasRollbackResolver | Expected | Test |
|---|---|---|---|---|---|
| Case 2 | projected | true | — | proceed | ✓ |
| Case 2 | projected | false | — | refuse NO_DOWN_FUNCTION | ✓ |
| Case 2 | snapshot | false | — | proceed | ✓ |
| Case 2 | fill-only | false | — | refuse NO_DOWN_FUNCTION | ✓ |
| Case 2 | custom | — | false | refuse NO_RESOLVER | ✓ |
| Case 2 | custom | — | true | proceed | ✓ |
| Case 3 | projected | true | — | proceed | ✓ |
| Case 3 | projected | false | — | refuse NO_DOWN_FUNCTION | ✓ |
| Case 3 | snapshot | true | — | refuse FINALIZED_ONLY_PROJECTED | ✓ |
| Case 3 | fill-only | true | — | refuse FINALIZED_ONLY_PROJECTED | ✓ |
| Case 3 | custom | — | true | proceed | ✓ |
| Case 3 | custom | — | false | refuse NO_RESOLVER | ✓ |
| Case 1 (failed) | projected | false | — | proceed (ignores strategy) | ✓ |
| Case 1 (release) | snapshot | false | — | proceed (ignores strategy) | ✓ |
| — | — | — | — | refuse EDB_MIGRATION_NOT_FOUND | ✓ |
| — | reverted | — | — | refuse EDB_ALREADY_REVERTED | ✓ |
| — | pending | — | — | refuse EDB_NOT_APPLIED | ✓ |
| — | head violation | — | — | refuse EDB_ROLLBACK_OUT_OF_ORDER | ✓ |
| — | remediation (not-found) | — | — | .remediation truthy | ✓ |
| — | remediation (no-down) | — | — | .remediation truthy | ✓ |

## Source-Scan Invariants (Plan 05-01 deliverable)

`pnpm vitest run tests/unit/lock/source-scan.test.ts` → **3/3 PASS**

The source-scan assertion that previously checked `src/rollback/` was absent was updated to `toBe(true)` as planned — the glob now picks up the new `src/rollback/` files and verifies they comply with the CONSISTENT_READ + no-setInterval + no-inline-consistent-true invariants. `preconditions.ts` does not call `migrationState.get(...)` directly (it delegates to `readLockRow`) so it passes the consistency check cleanly.

## Commits

| Feature | Commit | Description |
|---|---|---|
| RED 1 | a8cc903 | test(05-02): RED — failing tests for determineLifecycleCase |
| GREEN 1 | f08a287 | feat(05-02): GREEN — determineLifecycleCase per RBK truth table |
| RED 2 | b1d9763 | test(05-02): RED — failing tests for findHeadViolation |
| GREEN 2 | 3d810fa | feat(05-02): GREEN — findHeadViolation per RBK-01 |
| RED 3 | a34ed2b | test(05-02): RED — failing tests for checkPreconditions truth table |
| GREEN 3 | b782db2 | feat(05-02): GREEN — checkPreconditions composes lifecycle + head-only |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Case 1 short-circuit added to prevent false NO_DOWN_FUNCTION refusals**

- **Found during:** Feature 3 GREEN phase (first run: 19/20 tests passing)
- **Issue:** The plan's numbered step sequence (Steps 8-9 after Step 7) ran strategy/capability checks for ALL lifecycle cases including Case 1. For a `status='failed'` migration without `down()`, strategy `projected` was refusing with `NO_DOWN_FUNCTION` instead of proceeding as Case 1.
- **Fix:** Added explicit Case 1 guard immediately after `determineLifecycleCase` returns `'case-1'`: `if (lifecycleCase === 'case-1') return { kind: 'proceed', case: 'case-1', targetRow };` — consistent with RESEARCH §Section 1 which states "strategy is recorded but the action is identical for Case 1" and "down NOT required".
- **Files modified:** `src/rollback/preconditions.ts`
- **Commit:** b782db2 (same commit as GREEN 3 — fixed inline before commit)

## Known Stubs

None. All production files have complete implementations.

## Threat Flags

No new threat surface beyond what the plan's threat model documents (T-05-02-01 through T-05-02-04 all handled — head-only refusal is the T-05-02-01/T-05-02-03 data-corruption defense; parameterized truth-table tests are the T-05-02-03 mitigation; single scan + single GetItem is the T-05-02-04 rationale).

## Self-Check: PASSED
