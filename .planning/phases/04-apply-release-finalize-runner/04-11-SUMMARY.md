---
phase: 04-apply-release-finalize-runner
plan: 11
subsystem: public-api
tags:
  - public-api
  - client
  - phase-04
  - wave-3
  - tdd
dependency_graph:
  requires:
    - 04-04 (applyBatch runner)
    - 04-09 (finalizeFlow runner)
    - 04-10 (history, state-mutations)
  provides:
    - createMigrationsClient programmatic API (API-01, API-02)
    - MigrationsClient interface (apply, finalize, release, history, status, guardedClient)
    - src/runner/index.ts barrel (runner-internal, not re-exported from public surface)
  affects:
    - src/index.ts (two new exports added)
    - tests/unit/build/public-surface.test.ts (EXPECTED_RUNTIME_KEYS updated)
tech_stack:
  added: []
  patterns:
    - TDD (RED→GREEN, no REFACTOR needed)
    - Factory pattern: createMigrationsClient wires runner orchestrators to user DDB client
    - Two-client split: unguarded docClient for runner, guarded client for user app
    - tableName 3-tier resolution: explicit arg > config.tableName string > config.tableName() thunk
key_files:
  created:
    - src/client/types.ts
    - src/client/create-migrations-client.ts
    - src/client/index.ts
    - src/runner/index.ts
    - tests/unit/client/create-migrations-client.test.ts
    - tests/unit/index.test.ts
  modified:
    - src/index.ts
    - tests/unit/build/public-surface.test.ts
decisions:
  - "tableName resolution uses plain Error (not typed EDB class) per W-01 pinned decision"
  - "release() rejects with EDB_RELEASE_PREMATURE for ALL FIVE non-release/non-free lockStates (apply, finalize, rollback, failed, dying) — W-04 exhaustive"
  - "dying disposition rejects like apply: clearing a dying lock would wipe an in-flight audit trail"
  - "history() returns raw HistoryRow array; CLI (Plan 13) formats via formatHistoryJson"
  - "runner barrel (src/runner/index.ts) is consumed by src/client/ but NOT re-exported from src/index.ts"
metrics:
  duration: "8m 36s"
  completed: "2026-05-08T21:06:52Z"
  tasks: 1
  files_created: 6
  files_modified: 2
---

# Phase 4 Plan 11: createMigrationsClient Programmatic API Summary

**One-liner:** `createMigrationsClient` factory wiring applyBatch/finalizeFlow/readLockRow to user DDB client with exhaustive lockState guards and tableName 3-tier resolution.

## What Was Built

The v0.1 blocking programmatic API (`API-01`, `API-02`, `API-06`). The factory accepts a user DynamoDB client + resolved config and returns a `MigrationsClient` with 6 methods:

| Method | Behavior |
|--------|----------|
| `apply(args?)` | Discovers pending migrations via `loadPendingMigrations`, runs `applyBatch`. Fresh `runId` per call. |
| `finalize(id\|{all:true})` | Delegates to `finalizeFlow` for a single id; iterates `status='applied'` rows for `{all:true}`. |
| `release()` | Reads lock row via `readLockRow`; idempotent on null/'free'; throws `EDB_RELEASE_PREMATURE` for apply/finalize/rollback/failed/dying. |
| `history(filter?)` | Scans `_migrations`; normalizes `reads` Set→sorted array; optionally filters by entity. |
| `status()` | Returns `{lock, recent}` from `readLockRow` + recent `_migrations` scan (top 10 descending). |
| `guardedClient()` | Returns the user's guarded DDB client (Phase 3 middleware applied); runner uses unguarded client. |

## TDD Gate Compliance

RED→GREEN sequence confirmed in git log:
1. `test(04-11): RED — createMigrationsClient surface (API-01, API-02)` — 7fcca29
2. `test(04-11): RED — public surface adds createMigrationsClient (API-06 regression)` — 7bae4c2
3. `feat(04-11): GREEN — createMigrationsClient + public surface (API-01, API-02, API-06)` — a911c03

## Test Cases Implemented

### CMC test names (create-migrations-client.test.ts — 29 tests)

| Case | Description | Status |
|------|-------------|--------|
| CMC-1 | Factory shape: exactly 6 methods (apply, finalize, release, history, status, guardedClient) | PASS |
| CMC-2a | tableName: explicit arg wins over config | PASS |
| CMC-2b | tableName: config.tableName string used when no explicit arg | PASS |
| CMC-2c | tableName: config.tableName() thunk called and result used | PASS |
| CMC-2d | tableName missing: throws plain Error with W-01 required substrings | PASS |
| CMC-3a | holder defaults to `<hostname>:<pid>` when omitted | PASS |
| CMC-3b | holder uses provided value when set | PASS |
| CMC-4a | apply() calls loadPendingMigrations + applyBatch with no args | PASS |
| CMC-4b | apply({migrationId}) forwards migrationId to applyBatch | PASS |
| CMC-4c | apply() does NOT forward migrationId when not provided | PASS |
| CMC-5 | apply() generates different runId per call (UUID format) | PASS |
| CMC-6a | finalize(id) finds migration and calls finalizeFlow | PASS |
| CMC-6b | finalize(id) throws when migration not found | PASS |
| CMC-6c | finalize({all:true}) calls finalizeFlow once per 'applied' row | PASS |
| CMC-7a | release(): null lock row → {cleared: false, reason: 'no-active-release-lock'} | PASS |
| CMC-7b | release(): 'free' state → {cleared: false, reason: 'no-active-release-lock'} | PASS |
| CMC-7c | release(): 'release' state → calls clear, returns {cleared: true} | PASS |
| CMC-7d | release(): 'apply' state → throws EDB_RELEASE_PREMATURE | PASS |
| CMC-7e | release(): 'finalize' state → throws EDB_RELEASE_PREMATURE | PASS |
| CMC-7f | release(): 'rollback' state → throws EDB_RELEASE_PREMATURE | PASS |
| CMC-7g | release(): 'failed' state → throws EDB_RELEASE_PREMATURE | PASS |
| CMC-7h | release(): 'dying' state → throws EDB_RELEASE_PREMATURE | PASS |
| CMC-8a | history() returns typed HistoryRow array | PASS |
| CMC-8b | history({entity}) filters by entityName | PASS |
| CMC-8c | history(): reads Set converted to sorted array | PASS |
| CMC-9a | status() returns {lock, recent} from readLockRow + migrations scan | PASS |
| CMC-9b | status() returns {lock: null, recent: []} when no data | PASS |
| CMC-10a | guardedClient() returns DynamoDBDocumentClient-like object | PASS |
| CMC-10b | guardedClient() returns same instance on repeated calls | PASS |

### PS test names (index.test.ts — 26 tests)

| Case | Description | Status |
|------|-------------|--------|
| PS-1 | All 11 existing exports unchanged | PASS |
| PS-2 | createMigrationsClient exported as function | PASS |
| PS-3 | 13 internal helpers NOT exported | PASS |
| PS-4 | createMigrationsClient smoke: callable, returns object with 6 methods | PASS |

## File Byte Counts

| File | Lines |
|------|-------|
| `src/client/types.ts` | 73 |
| `src/client/create-migrations-client.ts` | 207 |
| `src/client/index.ts` | 3 |
| `src/runner/index.ts` | 15 |
| `tests/unit/client/create-migrations-client.test.ts` | 535 |
| `tests/unit/index.test.ts` | 163 |

## Internal Verb Leak Verification

```
grep -nE "transitionReleaseToApply|applyFlow|finalizeFlow|loadPendingMigrations|..." src/index.ts
→ Only JSDoc comment mention, no export statement. CLEAN.
```

`src/runner/index.ts` is consumed by `src/client/` but NOT transitively re-exported from `src/index.ts`. The `src/client/index.ts` barrel only exports `createMigrationsClient` and `type MigrationsClient`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated public-surface.test.ts EXPECTED_RUNTIME_KEYS**
- **Found during:** GREEN phase (full test run)
- **Issue:** `tests/unit/build/public-surface.test.ts` asserted exact runtime keys and did not include `createMigrationsClient`, causing 1 test failure after adding the new export to `src/index.ts`.
- **Fix:** Added `'createMigrationsClient'` to `EXPECTED_RUNTIME_KEYS` array. This test correctly enforces the public surface contract.
- **Files modified:** `tests/unit/build/public-surface.test.ts`
- **Commit:** a911c03 (included in GREEN commit)

**2. [Rule 1 - Bug] Fixed test mock signatures**
- **Found during:** GREEN phase (test run)
- **Issue 1:** `vi.mock('../../../src/guard/index.js')` mock for `wrapClient` used `(docClient, _args)` but real signature is `(WrapClientArgs)` — mock returned the args object instead of the client, breaking CMC-10.
- **Issue 2:** `it.each` tuple destructuring had wrong type signature (`lockState, label` but function only used `lockState`).
- **Issue 3:** `makeStubBundle._migrationsScanGo` typed as `vi.fn(async () => ({ data: [] }))` inferred `never[]` for data — fixed with explicit `Record<string, unknown>[]` type annotation.
- **Issue 4:** `makeConfig(undefined)` in TypeScript triggers the default parameter `'test-table'` — fixed by using object spread to explicitly set `tableName: undefined`.
- **Fix:** Updated mock signatures and type annotations in test file.
- **Files modified:** `tests/unit/client/create-migrations-client.test.ts`
- **Commit:** a911c03

## Known Stubs

None. All 6 client methods delegate to real runner orchestrators (stubbed in tests via `vi.mock`). The `guardedClient()` method returns the Phase 3 guard-wrapped client. No data is hardcoded or missing a source.

## Threat Flags

No new trust boundaries introduced. The factory validates tableName (T-04-11-01 mitigated via `resolveTableName`), splits guarded/unguarded clients (T-04-11-03 mitigated), and generates fresh runIds per call (T-04-11-04 mitigated). All 5 threat register items are covered by tests.

## Self-Check

Files exist:
- src/client/types.ts: FOUND
- src/client/create-migrations-client.ts: FOUND
- src/client/index.ts: FOUND
- src/runner/index.ts: FOUND
- tests/unit/client/create-migrations-client.test.ts: FOUND
- tests/unit/index.test.ts: FOUND

Commits exist:
- 7fcca29: FOUND (RED — CMC tests)
- 7bae4c2: FOUND (RED — PS tests)
- a911c03: FOUND (GREEN — implementation)

## Self-Check: PASSED
