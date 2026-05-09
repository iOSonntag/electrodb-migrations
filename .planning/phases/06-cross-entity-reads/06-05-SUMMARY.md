---
phase: 06
plan: 05
subsystem: rollback
tags:
  - ctx
  - ctx-08
  - rollback-preconditions
  - phase-06
  - wave-4
dependency_graph:
  requires:
    - src/errors/codes.ts (Phase 1 — ROLLBACK_REASON_CODES base)
    - src/rollback/head-only.ts (Phase 5 — MigrationsRow, findHeadViolation)
    - src/rollback/preconditions.ts (Phase 5 — checkPreconditions Steps 1-9)
    - tests/unit/rollback/preconditions-ctx08.test.ts (Phase 6 Plan 01 — RED scaffold)
  provides:
    - src/errors/codes.ts (extended with READS_DEPENDENCY_APPLIED)
    - src/rollback/preconditions.ts (Step 10 + findBlockingReadsDependency helper)
    - src/rollback/head-only.ts (MigrationsRow extended with fromVersion?, reads?)
    - tests/unit/rollback/preconditions-ctx08.test.ts (8 GREEN tests covering CTX-08)
  affects:
    - Plan 06-06 (integration tests — CTX-08 precondition gate will be exercised end-to-end)
tech_stack:
  added: []
  patterns:
    - Step-insert pattern into existing checkPreconditions gate (Phase 5 contract preserved)
    - fromVersion numeric comparison for cross-entity sequence ordering (clock-skew safe)
    - Set<string>/string[] normalisation at the point of use (ElectroDB TS vs runtime gap)
    - Earliest-blocker-first sorting in findBlockingReadsDependency
key_files:
  created: []
  modified:
    - src/errors/codes.ts
    - src/rollback/head-only.ts
    - src/rollback/preconditions.ts
    - tests/unit/errors/codes.test.ts
    - tests/unit/rollback/preconditions-ctx08.test.ts
decisions:
  - "fromVersion numeric comparison (not appliedAt) for CTX-08 blocking check — clock-skew safe per RESEARCH §A3 / Pitfall 6"
  - "MigrationsRow.fromVersion made optional (backward compat for head-only tests that pre-date CTX-08)"
  - "scan cast widened to unknown first in preconditions.ts — ElectroDB TS infers set attributes as string[] but runtime is Set<string>"
  - "findBlockingReadsDependency normalises reads field defensively via Array.isArray to handle both representations"
  - "READS_DEPENDENCY_APPLIED has no EDB_ prefix — sub-code inside EDB_ROLLBACK_NOT_POSSIBLE per existing convention"
metrics:
  duration_minutes: 7
  tasks_completed: 2
  files_created: 0
  files_modified: 5
  completed_date: "2026-05-09"
---

# Phase 06 Plan 05: CTX-08 Reads Dependency Rollback Check Summary

**One-liner:** CTX-08 implemented as Step 10 in checkPreconditions using fromVersion numeric comparison — refuses rollback when any reads-target entity has a later applied/finalized migration; Plan 06-01 RED tests flipped to GREEN (8/8).

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add READS_DEPENDENCY_APPLIED + extend MigrationsRow | b5fe24d | src/errors/codes.ts, src/rollback/head-only.ts, src/rollback/preconditions.ts, tests/unit/errors/codes.test.ts |
| 2 | Implement Step 10 + findBlockingReadsDependency; flip RED→GREEN | 6b8ee72 | src/rollback/preconditions.ts, tests/unit/rollback/preconditions-ctx08.test.ts |

## Implementation Details

### CTX-08 Blocking Definition

A `_migrations` row R blocks rollback of target M when ALL of:
1. `R.entityName ∈ targetRow.reads` (R migrates a reads-target entity)
2. `R.status ∈ {'applied', 'finalized'}` (active dependency — not reverted/pending)
3. `parseInt(R.fromVersion) >= parseInt(targetRow.toVersion)` (reads-target was moved to a version >= what M was authored against)

### Clock-Skew Safety

Comparison uses `fromVersion` (sequence-monotonic per entity) rather than `appliedAt` ISO timestamps. ISO timestamps can drift between developer machines. This matches RESEARCH §A3 / Pitfall 6.

### Case-1 Unaffected

The Case 1 short-circuit at Step 7 (pre-release rollback — `status: failed` or `lockState: release`) returns `{ kind: 'proceed', case: 'case-1' }` before Step 10 is ever reached. This is intentional: pre-release rollback doesn't carry a reads-dependency semantic.

### Strategy-Agnostic

Step 10 fires for all strategies (`projected`, `snapshot`, `fill-only`, `custom`). The refusal is at the precondition gate; no strategy bypasses it. This satisfies T-06-05-03.

### Error Shape

```typescript
EDBRollbackNotPossibleError(message, {
  reason: 'READS_DEPENDENCY_APPLIED',
  blockingMigration: '<id of earliest blocking row>',
  readsDependency: '<entityName of blocking row>',
  migrationId: '<id of target migration M>',
})
// + .remediation: "Run `rollback <blockingId>` first, then re-run `rollback <migId>`."
```

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm tsc --noEmit` | PASS |
| `pnpm vitest run tests/unit/rollback/preconditions-ctx08.test.ts` (8/8) | PASS |
| `pnpm vitest run tests/unit/rollback/preconditions.test.ts` (20/20) | PASS |
| `pnpm vitest run tests/unit/rollback/orchestrator.test.ts` (21/21) | PASS |
| `pnpm vitest run tests/unit/lock/source-scan.test.ts` (3/3) | PASS |
| `pnpm vitest run tests/unit/errors/` (8/8 per file) | PASS |
| `pnpm vitest run tests/unit/` (994/994) | PASS |

## CTX-08 Unit Test Coverage (8 cases)

| # | Case | Expected |
|---|------|----------|
| 1 | reads-target has later-applied migration (fromVersion >= toVersion) | refuse / READS_DEPENDENCY_APPLIED |
| 2 | target has no reads declaration (undefined) | proceed |
| 3 | reads-target has only earlier-version migrations (fromVersion < toVersion) | proceed |
| 4 | READS_DEPENDENCY_APPLIED exact literal in details.reason | refuse / 'READS_DEPENDENCY_APPLIED' |
| 5 | reads-target has finalized later-version migration | refuse / READS_DEPENDENCY_APPLIED |
| 6 | reads-target has reverted later-version migration | proceed (reverted = not blocking) |
| 7 | remediation contains blocking migration id + 'first' | remediation field present |
| 8 | multiple blockers — earliest reported (lowest fromVersion) | blockingMigration = earliest id |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript cast widening in preconditions.ts line 92**
- **Found during:** Task 1
- **Issue:** Adding `reads?: Set<string>` to `MigrationsRow` caused a TS2352 cast error on the existing `as { data: MigrationsRow[] }` cast at line 92. ElectroDB's TypeScript type infers `set`-attribute fields as `string[]`; the cast to `Set<string>` was flagged as incompatible.
- **Fix:** Changed the cast to `as unknown as { data: MigrationsRow[] }` and added a comment explaining the ElectroDB TS/runtime gap. The `findBlockingReadsDependency` helper normalises `reads` defensively via `Array.isArray` to handle both representations at runtime.
- **Files modified:** src/rollback/preconditions.ts (1 line)
- **Commit:** b5fe24d

**2. [Rule 1 - Bug] MigrationsRow.fromVersion made optional**
- **Found during:** Task 1
- **Issue:** Adding required `fromVersion: string` to `MigrationsRow` broke `tests/unit/rollback/head-only.test.ts` — the test has a local `MigRow` type that doesn't include `fromVersion` (pre-CTX-08 rows).
- **Fix:** Made `fromVersion?: string` optional with a comment explaining it was optional for backward-compat with head-only callers. The `findBlockingReadsDependency` helper uses `r.fromVersion ?? ''` defensively.
- **Files modified:** src/rollback/head-only.ts (changed required to optional)
- **Commit:** b5fe24d

**3. [Rule 2 - Missing functionality] Updated codes.test.ts to cover the new reason code**
- **Found during:** Task 1
- **Issue:** `tests/unit/errors/codes.test.ts` had an exact-match test for the three Phase 5 reason codes. Adding `READS_DEPENDENCY_APPLIED` caused a test failure.
- **Fix:** Updated the test to include the new code, and added two additional regression tests: one confirming Phase 5 codes are unchanged (wire-format safety), and one confirming no `EDB_` prefix on the new code.
- **Files modified:** tests/unit/errors/codes.test.ts
- **Commit:** b5fe24d

## Known Stubs

None — all implementation is production-complete. No placeholder values.

## Threat Surface Scan

No new network endpoints, auth paths, or DDB schema changes introduced. The CTX-08 check reads existing `_migrations` rows (already scanned in Step 1). One new error type exposed in the `checkPreconditions` return union — already part of `EDBRollbackNotPossibleError` which is in the public API. No threat flags.

## Self-Check: PASSED

Files verified:
- src/errors/codes.ts: FOUND with READS_DEPENDENCY_APPLIED
- src/rollback/head-only.ts: FOUND with reads?: Set<string>
- src/rollback/preconditions.ts: FOUND with findBlockingReadsDependency
- tests/unit/errors/codes.test.ts: FOUND
- tests/unit/rollback/preconditions-ctx08.test.ts: FOUND with 8 it() cases

Commits verified:
- b5fe24d (Task 1 — reason code + MigrationsRow extension)
- 6b8ee72 (Task 2 — Step 10 implementation + RED→GREEN flip)
