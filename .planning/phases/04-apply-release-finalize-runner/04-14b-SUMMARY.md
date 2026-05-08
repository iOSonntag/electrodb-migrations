---
phase: "04"
plan: "14b"
subsystem: runner-integration-tests
tags:
  - integration-tests
  - apply
  - finalize
  - release
  - guard
  - bug-fix
dependency_graph:
  requires:
    - "04-14a"  # apply end-to-end integration test (basic apply path)
    - "04-11"   # createMigrationsClient factory
    - "04-10"   # finalizeFlow
    - "04-04"   # applyBatch
  provides:
    - RUN-06-integration
    - RUN-07-integration
    - RUN-08-integration
    - FIN-01-integration
    - FIN-03-integration
    - B-03-integration
    - REL-01-integration
    - REL-02-integration
  affects:
    - src/runner/apply-flow.ts
    - src/runner/finalize-flow.ts
    - src/state-mutations/clear-finalize.ts
tech_stack:
  added:
    - clearFinalizeMode state-mutation verb (lockState=finalize condition)
  patterns:
    - _migrations row is PUT (status=pending) in applyFlowScanWrite before transitionToReleaseMode patches it
    - finalizeFlow uses clearFinalizeMode (not clear) after the delete loop
    - Guard middleware isolation via middlewareStack.clone() (bundle and guard stacks independent)
key_files:
  created:
    - tests/integration/runner/apply-failure-fail-fast.test.ts
    - tests/integration/runner/apply-sequence-enforcement.test.ts
    - tests/integration/runner/finalize.test.ts
    - tests/integration/runner/guarded-read-during-finalize.test.ts
    - tests/integration/runner/release-clear.test.ts
    - src/state-mutations/clear-finalize.ts
  modified:
    - src/client/create-migrations-client.ts
    - src/runner/apply-flow.ts
    - src/runner/finalize-flow.ts
    - src/state-mutations/index.ts
    - tests/_helpers/sample-migrations/User-add-status/migration.ts
    - tests/_helpers/sample-migrations/User-add-status/index.ts
    - tests/integration/runner/_helpers.ts
    - tests/unit/client/create-migrations-client.test.ts
    - tests/unit/index.test.ts
    - tests/unit/runner/_stub-service.ts
    - tests/unit/runner/apply-flow.test.ts
    - tests/unit/runner/finalize-flow.test.ts
decisions:
  - "clearFinalizeMode verb added instead of reusing clear() — clear() condition is lockState=release (apply path), finalize uses lockState=finalize"
  - "_migrations row is PUT with status=pending in applyFlowScanWrite before transitionToReleaseMode; ElectroDB patch() requires attribute_exists(pk) and fails on non-existent rows"
  - "Failed _migrations row is patched to status=failed in applyFlow catch block (best-effort, separate from markFailed TransactWrite)"
  - "RUN-08 re-apply test updated: failed migration is filtered from pending list so second apply returns {applied:[]} rather than blocking on lock"
metrics:
  duration: "~60 minutes (2 sessions across context boundary)"
  completed: "2026-05-08T21:50:49Z"
  tasks_completed: 4
  files_changed: 18
---

# Phase 4 Plan 14b: Runner Integration Tests (RUN-08/06/07, FIN-01/03, B-03, REL-01/02) Summary

Integration test suite for apply failure, sequence enforcement, finalize, guarded reads during finalize, and release — with two Rule 1 bug fixes discovered during execution.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | apply-failure-fail-fast + apply-sequence-enforcement tests + client migrations array + guard isolation | efc1a4b |
| 2 | finalize test + _migrations row lifecycle bug fix + clearFinalizeMode verb | 142f636 |
| 3 | B-03 guarded-read-during-finalize test | 5d5eab0 |
| 4 | REL-01/02 release-clear test | 8e689f3 |

## Test Coverage Added

### apply-failure-fail-fast.test.ts (RUN-08)
- `up()` throws on record `u-000010` → `_migrations.status='failed'` AND `lockState='failed'`
- Second apply returns `{applied:[]}` (migration not pending) and lock stays `'failed'`

### apply-sequence-enforcement.test.ts (RUN-06/07)
- RUN-06a: apply `--migration <future-id>` rejects with `EDB_NOT_NEXT_PENDING`, names actual next id
- RUN-06b: apply `--migration <unknown-id>` rejects with `EDB_NOT_PENDING`
- RUN-07: apply against zero-pending (all `'applied'`) returns `{applied:[]}` cleanly

### finalize.test.ts (FIN-01/03)
- apply → release → finalize end-to-end with 100 records
- B-01 fixture (User-add-status): v1 and v2 have DISTINCT SKs, finalize deletes only v1
- Asserts: 100 v1 rows deleted, 100 v2 rows untouched, `_migrations.status='finalized'`, lock='free'

### guarded-read-during-finalize.test.ts (B-03)
- 20 concurrent guarded GETs fired while finalize runs (100 records, 50ms spacing)
- ALL 20 GETs succeed — Decision A7 proven: `'finalize'` NOT in `GATING_LOCK_STATES`
- lockState='finalize' was observed during the run (non-vacuous assertion)

### release-clear.test.ts (REL-01/02)
- REL-01: `release()` after `apply()` clears release-mode lock (`cleared: true`, lockState='free')
- REL-02a: `release()` on free lock → `{cleared: false, reason: 'no-active-release-lock'}`
- REL-02b: two consecutive `release()` → first cleared, second no-op
- REL-02c: `release()` while lock in 'apply' → `EDB_RELEASE_PREMATURE`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `_migrations` row not created before transitionToReleaseMode patches it**

- **Found during:** Task 2 (finalize.test.ts failing: `transitionToReleaseMode refused`)
- **Root cause:** ElectroDB's `patch()` adds implicit `attribute_exists(pk) AND attribute_exists(sk)` condition. The `_migrations` row didn't exist before the TransactWrite in `transitionToReleaseMode` tried to patch it (item 1). The LCK-05 integration test had worked because it pre-seeded rows manually; this plan was the first to run a full end-to-end `client.apply()`.
- **Fix:** `applyFlowScanWrite` now PUTs the `_migrations` row with `status='pending'` before the scan loop. A best-effort `.patch({ status: 'failed' })` is added in `applyFlow`'s catch block.
- **Files modified:** `src/runner/apply-flow.ts`
- **Commit:** 142f636

**2. [Rule 1 - Bug] `finalizeFlow` called `clear()` which requires `lockState='release'` but finalize uses `lockState='finalize'`**

- **Found during:** Task 2 (finalize.test.ts second failure after fixing bug 1)
- **Root cause:** `clear()` has ConditionExpression `lockState = 'release' AND lockRunId = :runId`. Finalize acquires with `mode='finalize'` (sets `lockState='finalize'`), so `clear()` always fails.
- **Fix:** Created new `clearFinalizeMode` verb with condition `lockState = 'finalize' AND lockRunId = :runId`. Updated `finalizeFlow` to use it. Exported from `state-mutations/index.ts`. Updated finalize-flow unit tests to mock `clearFinalizeMode`.
- **Files modified:** `src/state-mutations/clear-finalize.ts` (new), `src/runner/finalize-flow.ts`, `src/state-mutations/index.ts`, `tests/unit/runner/finalize-flow.test.ts`
- **Commit:** 142f636

**3. [Rule 1 - Bug] Unit tests missing `middlewareStack.clone()` mock (guard isolation)**

- **Found during:** Task 1 unit test failures after adding guard isolation via `middlewareStack.clone()`
- **Fix:** Updated `makeFakeDocClient()` in `create-migrations-client.test.ts`, `makeFakeStack()` pattern, and `PS-4` smoke test in `index.test.ts`. Also added `vi.mock internal-entities` in `apply-flow.test.ts` and updated `makeServiceStub()` with `migrations.put()` stub.
- **Files modified:** `tests/unit/client/create-migrations-client.test.ts`, `tests/unit/index.test.ts`, `tests/unit/runner/apply-flow.test.ts`, `tests/unit/runner/_stub-service.ts`
- **Commit:** efc1a4b (CMC tests), 142f636 (apply-flow tests)

**4. [Rule 1 - Bug] RUN-08 re-apply assertion incorrect after `_migrations.status='failed'` fix**

- **Found during:** Task 2 running all runner tests after fixing bug 1
- **Root cause:** Test expected second `client.apply()` to throw (lock blocking). Now the migration has `status='failed'` in `_migrations`, so `resolvePendingMigrations` filters it out and returns empty — `apply()` returns `{applied:[]}` without trying to acquire the lock. This is CORRECT behavior (failed migrations require `rollback` before retry, per T-04-04-04).
- **Fix:** Updated assertion to verify `apply()` returns `{applied:[]}` AND lock is still `'failed'` after.
- **Files modified:** `tests/integration/runner/apply-failure-fail-fast.test.ts`
- **Commit:** 142f636

## Known Stubs

None — all test data uses real DDB Local.

## Threat Flags

None — test-only additions. No new network endpoints or auth paths introduced in production code. The `clearFinalizeMode` verb operates within the existing lock row (same trust boundary as `clear()`, `markFailed()`).

## Self-Check: PASSED

Files created:
- tests/integration/runner/apply-failure-fail-fast.test.ts — EXISTS
- tests/integration/runner/apply-sequence-enforcement.test.ts — EXISTS
- tests/integration/runner/finalize.test.ts — EXISTS
- tests/integration/runner/guarded-read-during-finalize.test.ts — EXISTS
- tests/integration/runner/release-clear.test.ts — EXISTS
- src/state-mutations/clear-finalize.ts — EXISTS

Commits:
- efc1a4b — task 1 (apply tests + client)
- 142f636 — task 2 (finalize test + bug fixes)
- 5d5eab0 — task 3 (B-03 guarded read)
- 8e689f3 — task 4 (release-clear)

Test results: 761 unit tests PASSED, 57 integration tests PASSED
