---
phase: 05-rollback-strategies
plan: 10
subsystem: client
tags:
  - client
  - api
  - rollback
  - phase-05
  - wave-3
  - api-05
  - blocker-2
dependency_graph:
  requires:
    - src/rollback/orchestrator.ts (rollback, RollbackArgs, RollbackResult — Plan 05-09)
    - src/lock/unlock.ts (forceUnlock — Phase 3)
    - src/lock/read-lock-row.ts (readLockRow, LockRowSnapshot — Phase 3)
    - src/guard/cache.ts (getGuardCacheState, GuardStateSnapshot — Plan 05-01)
    - src/errors/unlock.ts (EDBUnlockRequiresConfirmationError — Plan 05-01)
    - tests/integration/rollback/_helpers.ts (setupRollbackTestTable — Plan 05-01)
  provides:
    - src/client/types.ts (MigrationsClient extended with 4 API-05 methods)
    - src/client/create-migrations-client.ts (4 method implementations + __bundle accessor)
    - tests/unit/client/api-05-surface.test.ts (5 unit test cases)
    - tests/integration/client/rollback-method.test.ts (3 integration test cases)
    - tests/integration/client/force-unlock-method.test.ts (10 integration test cases)
  affects:
    - tests/unit/client/create-migrations-client.test.ts (CMC-1 updated + rollback/guard mocks added)
    - Plan 05-11 (CLI rollback/unlock commands consume all 4 new methods)

tech-stack:
  added: []
  patterns:
    - "BLOCKER 2 yes-flag guard: forceUnlock() rejects with EDBUnlockRequiresConfirmationError when yes !== true, BEFORE any DDB I/O"
    - "Non-enumerable __bundle accessor: Object.defineProperty(client, '__bundle', {enumerable:false, writable:false, configurable:false}) for Plan 05-11 CLI consumer"
    - "resolveMigrationById private helper: preloaded-list lookup or disk-walk via loadPendingMigrations; caller throws EDB_MIGRATION_NOT_FOUND on miss"
    - "runUnguarded wrapper pattern: all DDB-touching methods use runUnguarded(); getGuardState() is in-process only (no runUnguarded needed)"

key-files:
  created:
    - tests/unit/client/api-05-surface.test.ts
    - tests/integration/client/rollback-method.test.ts
    - tests/integration/client/force-unlock-method.test.ts
  modified:
    - src/client/types.ts (4 new methods + 3 new type imports)
    - src/client/create-migrations-client.ts (4 method implementations + resolveMigrationById + __bundle + 4 new imports)
    - tests/unit/client/create-migrations-client.test.ts (CMC-1 updated; rollback/guard mocks added)

decisions:
  - "resolveMigrationById uses loadPendingMigrations for disk discovery: rollback targets applied/finalized migrations (not pending), but loadPendingMigrations loads from disk regardless of status — the filter applies to DDB state, not disk presence. Preloaded list covers all cases in tests and Lambda."
  - "getGuardState() skips runUnguarded: the guard cache state is in-process only (no DDB I/O), so the runUnguarded bypass is unnecessary. Other methods use runUnguarded to bypass guard middleware on DDB calls."
  - "__bundle non-enumerable: Object.defineProperty ensures __bundle does not appear in Object.keys/spread/for-in, keeping the public MigrationsClient interface clean. Plan 05-11 reaches it via (client as unknown as {__bundle: MigrationsServiceBundle}).__bundle."
  - "type test uses conditional type rather than expectTypeOf with null: expectTypeOf on a null client crashes at runtime; the conditional-type assertion achieves the same compile-time guarantee without runtime crash."

metrics:
  duration_minutes: 25
  completed_date: "2026-05-09"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 3
---

# Phase 5 Plan 10: MigrationsClient API-05 Extension Summary

**MigrationsClient extended with four Phase-5 operator methods: `rollback`, `forceUnlock`, `getLockState`, `getGuardState` — thin wrappers over Wave 1+2 primitives with BLOCKER 2 `yes`-flag guard, `__bundle` non-enumerable accessor, and 18 tests (5 unit + 13 integration) covering the LCK-08 truth table and the BLOCKER 2 rejection paths end-to-end.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-05-09
- **Tasks:** 2 completed
- **Files created:** 3 (1 unit test + 2 integration tests)
- **Files modified:** 3 (types.ts, create-migrations-client.ts, create-migrations-client.test.ts)

## Accomplishments

### Task 1 — Types + Implementation

**`src/client/types.ts`** extended with:
- `rollback(id, options)` — wraps the orchestrator (RBK-02). `options.strategy` is typed to the four-value enum.
- `forceUnlock({runId, yes?})` — API-05 canonical signature (`yes?: boolean` per REQUIREMENTS.md line 188). JSDoc documents the BLOCKER 2 rejection.
- `getLockState()` — returns `LockRowSnapshot | null` (fresh consistent read, no caching).
- `getGuardState()` — returns `GuardStateSnapshot` from `src/guard/cache.ts` (in-process only).
- 3 new type imports: `UnlockResult`, `RollbackItemCounts`, `GuardStateSnapshot`.
- `__bundle` intentionally NOT on the interface (non-enumerable, untyped).

**`src/client/create-migrations-client.ts`** additions:
- `rollback()` — `runUnguarded` wrapper → `resolveMigrationById()` → `rollback()` orchestrator.
- `forceUnlock()` — BLOCKER 2: `if (forceArgs.yes !== true) throw new EDBUnlockRequiresConfirmationError(...)` BEFORE `runUnguarded`; proceed path: `runUnguarded(() => forceUnlockLib(bundle, {runId}))`.
- `getLockState()` — `runUnguarded(() => readLockRow(bundle))`.
- `getGuardState()` — `getGuardCacheState()` (no `runUnguarded` needed; in-process only).
- `resolveMigrationById()` private helper (preloaded list lookup → disk walk fallback).
- `Object.defineProperty(client, '__bundle', {value: bundle, enumerable: false, writable: false, configurable: false})` after all public methods attached.

### Task 2 — Tests

**`tests/unit/client/api-05-surface.test.ts`** (5 test cases):
1. All 4 new methods + 6 existing methods present as functions.
2. `__bundle` descriptor: `enumerable:false`, `writable:false`, `configurable:false`; identity-equal to bundle; absent from `Object.keys()` / spread.
3. `forceUnlock({runId})` (no yes) → `EDBUnlockRequiresConfirmationError`.
4. `forceUnlock({runId, yes: false})` → `EDBUnlockRequiresConfirmationError`.
5. `forceUnlock({runId, yes: true})` → calls `forceUnlockLib` once with correct `runId`.

**`tests/integration/client/rollback-method.test.ts`** (3 test cases against DDB Local):
1. `client.rollback(id, {strategy:'projected'})` happy path: 7 mixed records → count audit holds, lock → `'release'`, `_migrations.status='reverted'`, `rollbackStrategy='projected'`.
2. Out-of-order refusal: newer migration row pre-written → `EDB_ROLLBACK_OUT_OF_ORDER`; lock row `'free'` (no lock acquired).
3. TypeScript conditional-type assertion: `MigrationsClient['rollback']` return type satisfies `{itemCounts: RollbackItemCounts}`.

**`tests/integration/client/force-unlock-method.test.ts`** (10 test cases against DDB Local):
- LCK-08 truth table cells: `apply`, `rollback`, `finalize`, `dying` → `'failed'` (4 cases).
- LCK-08 cleared cells: `release`, `failed` → `'free'` (2 cases).
- `free` (no row) → `priorState='free'`; row unchanged (1 case).
- `getLockState()` reads `'free'` after `bootstrapMigrationState` (1 case).
- BLOCKER 2: `yes`-omitted rejection; lock row UNCHANGED post-rejection (1 case).
- BLOCKER 2: `yes:false` rejection; lock row UNCHANGED post-rejection (1 case).

## API-05 Requirements Satisfied

| Requirement | Description | Evidence |
|-------------|-------------|----------|
| API-05 rollback | `client.rollback(id, options)` entry point | rollback-method.test.ts case 1 |
| API-05 forceUnlock | `client.forceUnlock({runId, yes})` canonical signature | force-unlock-method.test.ts + api-05-surface.test.ts |
| API-05 getLockState | `client.getLockState()` fresh consistent read | force-unlock-method.test.ts case 7 |
| API-05 getGuardState | `client.getGuardState()` in-process guard snapshot | api-05-surface.test.ts case 1 |
| BLOCKER 2 | yes !== true → EDBUnlockRequiresConfirmationError before DDB I/O | api-05-surface.test.ts cases 2–3, force-unlock-method.test.ts cases 9–10 |

## GuardStateSnapshot Shape (for Plan 05-11 CLI consumer)

```typescript
// From src/guard/cache.ts (Plan 05-01) — pinned shape:
export interface GuardStateSnapshot {
  readonly cacheSize: number;           // always 0 or 1
  readonly lastReadAt?: string;         // ISO timestamp of last fetchLockState
  readonly lastReadResult?: 'allow' | 'block'; // 'allow' if lockState='free', else 'block'
}
```

`client.getGuardState()` returns `Object.freeze({...globalSnapshot})` — a frozen copy.

## Public Surface Unchanged

`src/index.ts` did NOT change. The four new methods are accessible only through the `MigrationsClient` object returned by `createMigrationsClient()`; no new symbols are added to the public package surface.

`EDBUnlockRequiresConfirmationError` and `EDBRollbackCountMismatchError` remain internal-only (not re-exported from `src/index.ts`), matching the precedent set in Plan 05-01.

## forceUnlock Rejection Confirmation

`client.forceUnlock({runId})` (or `{runId, yes: false}`) rejects with `EDBUnlockRequiresConfirmationError` (code: `'EDB_UNLOCK_REQUIRES_CONFIRMATION'`) BEFORE any DDB I/O — the lock row is provably unchanged at rejection time (verified by the BLOCKER 2 integration tests).

## Task Commits

| Task | Hash | Description |
|------|------|-------------|
| Task 1 | 6df6b24 | feat(05-10): extend MigrationsClient with rollback/forceUnlock/getLockState/getGuardState |
| Task 2 | 665551c | feat(05-10): API-05 surface unit test + rollback/forceUnlock integration tests |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] CMC-1 test asserted exactly 6 methods (would break on 10 methods)**

- **Found during:** Task 1
- **Issue:** `tests/unit/client/create-migrations-client.test.ts` CMC-1 asserted `Object.keys(client).sort() equals ['apply', 'finalize', 'guardedClient', 'history', 'release', 'status']`. Adding 4 new methods would break this test.
- **Fix:** Updated CMC-1 to assert the 10 enumerable methods; added `rollback/guard` mocks to the existing test file since `create-migrations-client.ts` now imports from those modules.
- **Files modified:** `tests/unit/client/create-migrations-client.test.ts`
- **Committed in:** 6df6b24 (Task 1)

**2. [Rule 1 - Bug] `expectTypeOf(client.rollback)` with a null client crashes at runtime**

- **Found during:** Task 2 (integration test run)
- **Issue:** The plan's suggested `expectTypeOf` type assertion accessed `.rollback` on a `null as unknown as MigrationsClient`, causing `TypeError: Cannot read properties of null`.
- **Fix:** Replaced with a conditional-type assertion pattern (`type _Assert = ... extends ... ? true : never`) which achieves compile-time enforcement without runtime access to the null object.
- **Files modified:** `tests/integration/client/rollback-method.test.ts`
- **Committed in:** 665551c (Task 2)

**Total deviations:** 2 auto-fixed (Rule 1 — bugs)
**Impact on plan:** Both fixes are correctness-only; no scope creep.

## Known Stubs

None. All 4 methods are fully implemented and delegate to their respective Wave 1+2 primitives. Integration tests verify end-to-end correctness against DDB Local.

## Self-Check: PASSED

- `src/client/types.ts` exists: FOUND
- `src/client/create-migrations-client.ts` exists: FOUND
- `tests/unit/client/api-05-surface.test.ts` exists: FOUND
- `tests/integration/client/rollback-method.test.ts` exists: FOUND
- `tests/integration/client/force-unlock-method.test.ts` exists: FOUND
- Task 1 commit 6df6b24: FOUND
- Task 2 commit 665551c: FOUND
- `pnpm tsc --noEmit`: PASS (0 errors)
- `npx vitest run tests/unit/`: 930/930 PASS
- `npx vitest run -c vitest.integration.config.ts tests/integration/client/`: 13/13 PASS
- Source-scan invariants: 3/3 PASS
- `src/index.ts` public surface: UNCHANGED (grep returns 0 for EDBUnlockRequiresConfirmationError and rollback/orchestrator)

## Threat Flags

No new threat surface beyond the plan's `<threat_model>`. All T-05-10-01..T-05-10-07 threats are mitigated as documented in the plan:
- T-05-10-05 (wrong strategy): TypeScript enum + orchestrator exhaustive-check.
- T-05-10-06 (programmatic forceUnlock bypasses CLI prompt): yes !== true rejection tested at unit + integration level.
- T-05-10-07 (__bundle leak): non-enumerable, non-writable; absent from Object.keys / spread; untyped on MigrationsClient interface.
