---
phase: 05-rollback-strategies
plan: 01
subsystem: test-infrastructure
tags:
  - test-infrastructure
  - phase-05
  - wave-0
  - errors
  - oq9
dependency_graph:
  requires: []
  provides:
    - tests/_helpers/sample-migrations/User-add-status-with-down/
    - tests/_helpers/sample-migrations/User-add-status-with-resolver/
    - tests/_helpers/sample-migrations/User-add-status-no-down/
    - tests/_helpers/sample-migrations/User-and-Team-std/
    - tests/integration/_helpers/seedV2Records
    - tests/integration/_helpers/seedMixedRecords
    - tests/integration/rollback/setupRollbackTestTable
    - tests/unit/rollback/makeRollbackStubService
    - src/errors/EDBRollbackCountMismatchError
    - src/errors/EDBUnlockRequiresConfirmationError
    - src/state-mutations/acquire (rollback mode OQ9)
    - src/guard/cache/getGuardCacheState
  affects:
    - src/state-mutations/acquire.ts (OQ9 widening)
    - src/guard/cache.ts (snapshot getter)
    - tests/unit/lock/source-scan.test.ts (glob extension)
tech_stack:
  added: []
  patterns:
    - Four fixture directories (with-down, with-resolver, no-down, User-and-Team-std)
    - Two scan-queue rollback stub pattern (v1/v2 keyed)
    - Mode-aware ConditionExpression builder (inlined closure)
    - Module-scope global snapshot for per-process cache state
key_files:
  created:
    - tests/_helpers/sample-migrations/User-add-status-with-down/v1.ts
    - tests/_helpers/sample-migrations/User-add-status-with-down/v2.ts
    - tests/_helpers/sample-migrations/User-add-status-with-down/migration.ts
    - tests/_helpers/sample-migrations/User-add-status-with-down/index.ts
    - tests/_helpers/sample-migrations/User-add-status-with-resolver/v1.ts
    - tests/_helpers/sample-migrations/User-add-status-with-resolver/v2.ts
    - tests/_helpers/sample-migrations/User-add-status-with-resolver/migration.ts
    - tests/_helpers/sample-migrations/User-add-status-with-resolver/index.ts
    - tests/_helpers/sample-migrations/User-add-status-no-down/v1.ts
    - tests/_helpers/sample-migrations/User-add-status-no-down/v2.ts
    - tests/_helpers/sample-migrations/User-add-status-no-down/migration.ts
    - tests/_helpers/sample-migrations/User-add-status-no-down/index.ts
    - tests/_helpers/sample-migrations/User-and-Team-std/v1.ts
    - tests/_helpers/sample-migrations/User-and-Team-std/v2.ts
    - tests/_helpers/sample-migrations/User-and-Team-std/team.ts
    - tests/_helpers/sample-migrations/User-and-Team-std/migration.ts
    - tests/_helpers/sample-migrations/User-and-Team-std/index.ts
    - tests/integration/_helpers/seed-v2-records.ts
    - tests/integration/_helpers/seed-mixed-records.ts
    - tests/integration/rollback/_helpers.ts
    - tests/unit/rollback/_stub-service.ts
    - src/errors/rollback.ts
    - src/errors/unlock.ts
  modified:
    - tests/integration/_helpers/index.ts
    - src/errors/index.ts
    - src/state-mutations/acquire.ts
    - src/guard/cache.ts
    - src/guard/index.ts
    - tests/unit/state-mutations/acquire.test.ts
    - tests/unit/lock/source-scan.test.ts
decisions:
  - OQ9 implemented via inline buildAcquireWhereExpression() closure inside acquire() to capture staleCutoff from enclosing scope — avoids type plumbing
  - GuardStateSnapshot uses module-scope mutable singleton (not WeakRef registry) matching existing single-cache-per-process usage pattern
  - source-scan glob extended to src/{lock,guard,runner,rollback}/**/*.ts; src/rollback/ absence assertion added (toBe(false)) to track when Plan 05-02 first creates a file there
  - EDBRollbackCountMismatchError and EDBUnlockRequiresConfirmationError are internal-only (not in src/index.ts) matching EDBBatchWriteExhaustedError precedent
metrics:
  duration_minutes: 45
  completed_date: "2026-05-09"
  tasks_completed: 5
  tasks_total: 5
  files_created: 23
  files_modified: 7
---

# Phase 5 Plan 01: Phase 5 Test Infrastructure (Wave 0) Summary

All Phase 5 rollback test infrastructure landed before any `src/rollback/` or CLI files exist — four fixture directories, two seed helpers, rollback integration bootstrap, unit stub service, two internal error classes, OQ9 acquire widening, and getGuardCacheState() shape pinned.

## What Was Built

### Task 1: Three single-entity rollback fixtures
Three near-identical fixture directories under `tests/_helpers/sample-migrations/`, differing only in their `migration.ts`:

- **User-add-status-with-down** (`id: 20260601000001`): canonical happy-path with `down()` — strips `status` and hidden `version` attribute. Used by projected/fill-only/custom strategy tests.
- **User-add-status-with-resolver** (`id: 20260601000002`): has both `down()` and `rollbackResolver`. Resolver implements the canonical A→v1Original / B→down(v2) / C→v1Original pattern per OQ7.
- **User-add-status-no-down** (`id: 20260601000003`): up-only fixture intentionally OMITTING `down` and `rollbackResolver`. Used by RBK-09/RBK-10 refusal tests.

All three v2.ts files use `composite: ['version']` (B-01 key-shape) and are byte-for-byte identical copies of the existing `User-add-status` v1/v2 entities.

### Task 2: STD fixture + seed helpers + integration bootstrap
- **User-and-Team-std**: User (v1+v2) and Team entities co-located in the same table, `model.service: 'app'`. The Team entity uses `teamLabel` (not `name`) for cross-contamination assertion clarity. Migration `entityName: 'User'` — Team is a sibling that must be invisible to User's rollback scan (RBK-11).
- **seedV2Records**: mirrors `seedV1Records` for v2 shape (id + name + status='active').
- **seedMixedRecords**: produces distinct A/B/C cell populations by namespaced id prefix (`a-`, `b-`, `c-`) with both-records / v2-only / v1-only seeding patterns. Returns `{aIds, bIds, cIds}` for per-cell post-condition assertions.
- **setupRollbackTestTable**: full lifecycle bootstrap supporting all 4 fixture variants, optional pre-seeding (v1Count/v2Count/mixed), and optional pre-writing the `_migrations` audit row at any status (applied/finalized/failed/pending).

### Task 3: Rollback unit stub + error classes + source-scan extension
- **makeRollbackStubService**: two-keyed scan queues (`'v1'`/`'v2'`), heterogeneous BatchWrite capture, `delete-params` capture. The `setScanPages('v1', pages)` / `setScanPages('v2', pages)` API lets type-table classifier unit tests assert each scan queue independently.
- **EDBRollbackCountMismatchError** (`code: 'EDB_ROLLBACK_COUNT_MISMATCH'`): internal-only, thrown when `scanned !== reverted + skipped + failed` after rollback loop. Mirrors `EDBBatchWriteExhaustedError` pattern.
- **EDBUnlockRequiresConfirmationError** (`code: 'EDB_UNLOCK_REQUIRES_CONFIRMATION'`): internal-only, thrown by `forceUnlock` when caller omits `yes: true`. BLOCKER 2 design.
- **source-scan glob**: extended to `src/{lock,guard,runner,rollback}/**/*.ts`. Assertion `expect(files.some(f => f.includes('src/rollback/'))).toBe(false)` added to track when Plan 05-02 first creates the directory.

### Task 4: OQ9 implementation (acquireLock rollback mode widening)
Modified `src/state-mutations/acquire.ts` to add `buildAcquireWhereExpression(mode)` inline helper:

- **apply/finalize** mode: `attribute_not_exists(lockState) OR lockState='free' OR (stale active states)` — byte-equal to pre-revision.
- **rollback** mode (OQ9): adds `OR lockState='release' OR lockState='failed'` so Case 2 + Case 3 rollback can acquire without `unlock`. Active non-stale `lockState='rollback'` still rejected.

20 new regression tests added to `tests/unit/state-mutations/acquire.test.ts` covering apply/rollback/finalize (mode × condition) matrix. All 29 test cases pass.

### Task 5: getGuardCacheState() shape pinned
Added to `src/guard/cache.ts`:
- `GuardStateSnapshot` interface with `{cacheSize: number, lastReadAt?: string, lastReadResult?: 'allow'|'block'}` — pinned shape per WARNING 3.
- `globalSnapshot` module-scope mutable singleton updated after each successful `fetchLockState` resolution.
- `getGuardCacheState()` returns `Object.freeze({ ...globalSnapshot })` — caller-safe frozen copy.
- `reset()` updated to preserve `lastReadAt`/`lastReadResult` while setting `cacheSize: 0`.
- Re-exported from `src/guard/index.ts`.

## Test Results

- `pnpm tsc --noEmit`: PASS (0 errors)
- `npx vitest run tests/unit/lock/source-scan.test.ts`: 3/3 PASS
- `npx vitest run tests/unit/state-mutations/acquire.test.ts`: 29/29 PASS
- `npx vitest run tests/unit/guard/`: 53/53 PASS (existing guard tests unaffected)

## Commits

| Task | Hash | Description |
|------|------|-------------|
| 1 | 03af0c9 | feat(05-01): add three single-entity rollback fixtures |
| 2 | cd8905e | feat(05-01): add STD fixture + integration seed helpers + rollback bootstrap |
| 3 | 0448066 | feat(05-01): rollback unit stub + error classes + source-scan glob extension |
| 4 | e8fb577 | feat(05-01): OQ9 — widen acquireLock(mode:'rollback') + regression tests |
| 5 | 68539d4 | feat(05-01): WARNING 3 — pin getGuardCacheState() shape in src/guard/cache.ts |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All files in this plan are either pure fixtures, test infrastructure, or production code additions with complete implementation (not stubs).

## Threat Flags

No new threat surface beyond what the plan's threat model documents (T-05-01-01 through T-05-01-06 all handled — internal-only invariant verified, OQ9 widening regression-tested, STD fixture uses ephemeral test tables only).

## Self-Check: PASSED

All created files exist, all commits verified in git log, TypeScript clean, all targeted tests green.
