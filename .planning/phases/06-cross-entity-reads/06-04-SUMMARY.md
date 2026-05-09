---
phase: 06
plan: 04
subsystem: rollback
tags:
  - ctx
  - rollback-retrofit
  - phase-06
  - wave-3
dependency_graph:
  requires:
    - src/ctx/types.ts (Plan 06-02 — MigrationCtx)
    - src/ctx/index.ts (Plan 06-03 — buildCtx barrel export)
    - src/ctx/build-ctx.ts (Plan 06-03 — buildCtx factory)
    - src/rollback/strategies/projected.ts (Phase 5 — ExecuteStrategyArgs baseline)
    - src/rollback/strategies/fill-only.ts (Phase 5 — fill-only executor)
    - src/rollback/strategies/custom.ts (Phase 5 — custom executor)
    - src/rollback/orchestrator.ts (Phase 5 — rollback() function)
    - src/client/create-migrations-client.ts (Plan 06-03 — cwd already in scope)
  provides:
    - src/rollback/strategies/projected.ts (ctx: MigrationCtx in ExecuteStrategyArgs; down!(v2, ctx))
    - src/rollback/strategies/fill-only.ts (ctx threaded to down!(v2, ctx))
    - src/rollback/strategies/custom.ts (ctx-bound one-arg down passed to resolver)
    - src/rollback/orchestrator.ts (buildCtx in case-2/3 else branch; cwd plumbing)
    - src/client/create-migrations-client.ts (cwd: thread to rollback args)
  affects:
    - Plan 06-06 (integration tests — rollback path now receives ctx)
tech_stack:
  added: []
  patterns:
    - "CTX-01 retrofit: ctx passed as second arg to migration.down(record, ctx) in all three rollback strategies"
    - "Closure-bound one-arg down: custom strategy wraps migration.down in (record, _ctx?) => migration.down!(record, ctx) so resolver keeps its one-arg down contract"
    - "Conditional buildCtx: built only in the case-2/3 else branch; case-1 skips it (Pitfall 5 avoidance)"
    - "buildCtx inside try{}: errors trigger markFailed + sched.stop (correct error semantics)"
    - "cwd threaded from client.rollback() through RollbackArgs.cwd to buildCtx"
key_files:
  created: []
  modified:
    - src/rollback/strategies/projected.ts (ctx: MigrationCtx added to ExecuteStrategyArgs; down!(v2, ctx))
    - src/rollback/strategies/fill-only.ts (down!(v2, ctx))
    - src/rollback/strategies/custom.ts (ExecuteCustomArgs ctx field; boundDown closure)
    - src/rollback/orchestrator.ts (buildCtx import; cwd?: string in RollbackArgs; ctx built in else branch)
    - src/client/create-migrations-client.ts (cwd threaded to rollback() call)
    - tests/unit/rollback/strategies/projected.test.ts (ctx added to all calls; CTX-01 contract test)
    - tests/unit/rollback/strategies/fill-only.test.ts (ctx added to all calls; CTX-01 contract test)
    - tests/unit/rollback/strategies/custom.test.ts (ctx added to all calls; ctx-bound down contract test)
    - tests/unit/rollback/orchestrator.test.ts (buildCtx mock; RB-17 + RB-18 tests)
decisions:
  - "buildCtx placed in case-2/3 else branch only — NOT before the case-1 dispatch: case-1 never calls migration.down so eager pre-flight via buildCtx would spuriously fail on freshly-baselined projects (Pitfall 5 / T-06-04-02)"
  - "Closure-bound one-arg down in custom strategy: the resolver's documented contract is down(v2) with one arg; binding ctx in the closure preserves this without changing RollbackResolverArgs.down type in src/migrations/types.ts"
  - "src/migrations/types.ts unchanged: no circular import; Migration.down keeps ctx?: unknown at the type definition level"
  - "snapshot strategy receives no ctx: it does not call migration.down; adding ctx to ExecuteSnapshotArgs would broaden the interface for no benefit"
  - "buildCtx mock added to orchestrator.test.ts via vi.mock('../../../src/ctx/index.js') so tests don't require snapshot files on disk"
metrics:
  duration_minutes: 25
  tasks_completed: 3
  files_created: 0
  files_modified: 9
  completed_date: "2026-05-09"
---

# Phase 06 Plan 04: Rollback ctx Retrofit (CTX-01 down-side coverage) Summary

**One-liner:** Retrofitted the rollback orchestrator and all three down()-calling strategy executors (projected, fill-only, custom) to thread `MigrationCtx` through `migration.down(record, ctx)`, completing CTX-01 coverage for the rollback path.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Retrofit projected + fill-only strategies to thread ctx | f630381 | src/rollback/strategies/projected.ts, src/rollback/strategies/fill-only.ts, tests/unit/rollback/strategies/projected.test.ts, tests/unit/rollback/strategies/fill-only.test.ts |
| 2 | Retrofit custom strategy — ctx-bound down to rollback resolver | b28a578 | src/rollback/strategies/custom.ts, tests/unit/rollback/strategies/custom.test.ts |
| 3 | Retrofit rollback orchestrator + cwd plumbing through client.rollback() | 97f0646 | src/rollback/orchestrator.ts, src/client/create-migrations-client.ts, tests/unit/rollback/orchestrator.test.ts |

## File Delta

9 files modified (plan target: 5 modified src files + 4 modified test files):
- 5 src files modified: projected.ts, fill-only.ts, custom.ts, orchestrator.ts, create-migrations-client.ts
- 4 test files modified: projected.test.ts, fill-only.test.ts, custom.test.ts, orchestrator.test.ts

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm tsc --noEmit` | PASS |
| `pnpm vitest run tests/unit/rollback/strategies/projected.test.ts` (10/10) | PASS |
| `pnpm vitest run tests/unit/rollback/strategies/fill-only.test.ts` (6/6) | PASS |
| `pnpm vitest run tests/unit/rollback/strategies/snapshot.test.ts` (9/9) | PASS — regression, snapshot unchanged |
| `pnpm vitest run tests/unit/rollback/strategies/custom.test.ts` (14/14) | PASS |
| `pnpm vitest run tests/unit/rollback/orchestrator.test.ts` (21/21) | PASS |
| `pnpm vitest run tests/unit/rollback/` (176/178 — 2 pre-existing RED) | PASS — 2 failures are preconditions-ctx08.test.ts (Plan 06-05 scope) |
| `pnpm vitest run tests/unit/ctx/` | PASS — ctx unit tests green |
| `pnpm vitest run tests/unit/lock/source-scan.test.ts` | PASS — no setInterval/consistent:true introduced |
| Full suite `pnpm vitest run` (986/988 — 2 pre-existing RED) | PASS |
| `src/rollback/strategies/snapshot.ts` unchanged | PASS — `git diff` shows no changes |
| `src/rollback/case-1-flow.ts` unchanged | PASS — `git diff` shows no changes |
| `src/migrations/types.ts` unchanged | PASS — no circular import introduced |
| `executeProjected` calls `migration.down!(entry.v2!, args.ctx)` | PASS (grep) |
| `executeFillOnly` calls `migration.down!(entry.v2!, args.ctx)` | PASS (grep) |
| `executeCustom` builds `boundDown` closure | PASS (grep) |
| `orchestrator.ts` buildCtx inside else branch only | PASS (grep: 1 `await buildCtx(` call) |
| `executeSnapshot` called WITHOUT `ctx` | PASS (grep: no ctx in snapshot call) |
| `rollbackCase1` called WITHOUT `ctx` | PASS (grep: no ctx in case-1 call) |
| `client.rollback()` passes `cwd` | PASS (grep: cwd in rollback args bag) |

## CTX-01 Coverage (Rollback Path)

| Strategy | Before (Phase 5) | After (Phase 6) |
|----------|-----------------|-----------------|
| projected | `migration.down!(v2)` — no ctx | `migration.down!(v2, ctx)` — ctx passed |
| fill-only | `migration.down!(v2)` — no ctx | `migration.down!(v2, ctx)` — ctx passed |
| custom | `down: migration.down` in resolver — no ctx | `boundDown = (r, _ctx?) => migration.down!(r, args.ctx)` — ctx closed over |
| snapshot | N/A — does not call down | N/A — still does not call down |
| case-1 | N/A — does not call down | N/A — still does not call down |

## Architecture: buildCtx Call Position in rollback()

```
rollback()
  │
  ├── checkPreconditions()                              ← Step 1
  │
  ├── acquireLock() → startLockHeartbeat()             ← Step 2
  │
  ├── try {
  │     sleep(acquireWaitMs)                            ← Step 3
  │
  │     if (case-1) {
  │       rollbackCase1()                               ← no ctx built
  │     } else {
  │       ctx = await buildCtx(migration, client,      ← Phase 6 (inside try)
  │                            tableName, cwd)
  │       classify = classifyTypeTable(...)
  │       switch (strategy) {
  │         case 'projected': executeProjected({ ..., ctx })
  │         case 'fill-only': executeFillOnly({ ..., ctx })
  │         case 'custom':    executeCustom({ ..., ctx })
  │         case 'snapshot':  executeSnapshot({ ... })  ← no ctx
  │       }
  │     }
  │     audit.assertInvariant()
  │     transitionToReleaseMode(...)
  │   }
  │   catch → markFailed()
  │   finally → sched.stop()
```

Key safety invariants:
- buildCtx is INSIDE the try block: if it throws, markFailed runs in catch (T-06-04-03 mitigated)
- buildCtx is ONLY in the else branch: case-1 skips pre-flight (T-06-04-02 mitigated)
- snapshot strategy does NOT receive ctx: its interface stays frozen (no Wave 4 conflicts)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All changes are fully functional.

## Threat Surface Scan

No new network endpoints or auth paths. The `buildCtx` call in the rollback orchestrator uses the same `entitySnapshotPath` + `readEntitySnapshot` path traversal already validated in `src/snapshot/paths.ts`. No new threat flags.

## Threat Model Mitigations Applied

| Threat ID | Mitigation Applied |
|-----------|--------------------|
| T-06-04-01 | All three down()-calling strategies (projected, fill-only, custom) pass ctx as second arg. Contract tests assert `down.mock.calls[0] = [record, fakeCtx]`. |
| T-06-04-02 | buildCtx call is inside the `else` branch (case-2/3 only). RB-17 test asserts `mockBuildCtx.not.toHaveBeenCalled()` for case-1. |
| T-06-04-03 | buildCtx call is inside the `try{}` block. If buildCtx throws, the catch block runs markFailed and finally runs sched.stop. |
| T-06-04-04 | Accepted — closure inspection is not a real attack vector; resolver is user-trusted code. |

## Self-Check: PASSED

Files verified:
- src/rollback/strategies/projected.ts: FOUND + calls down!(v2, args.ctx)
- src/rollback/strategies/fill-only.ts: FOUND + calls down!(v2, args.ctx)
- src/rollback/strategies/custom.ts: FOUND + builds boundDown closure
- src/rollback/orchestrator.ts: FOUND + imports buildCtx + cwd?: string in RollbackArgs
- src/client/create-migrations-client.ts: FOUND + cwd in rollback() call
- src/rollback/strategies/snapshot.ts: UNCHANGED (git diff empty)
- src/rollback/case-1-flow.ts: UNCHANGED (git diff empty)
- src/migrations/types.ts: UNCHANGED (no circular import)
- tests/unit/rollback/strategies/projected.test.ts: FOUND + CTX-01 contract test
- tests/unit/rollback/strategies/fill-only.test.ts: FOUND + CTX-01 contract test
- tests/unit/rollback/strategies/custom.test.ts: FOUND + ctx-bound down contract test
- tests/unit/rollback/orchestrator.test.ts: FOUND + RB-17 + RB-18 tests

Commits verified:
- f630381 (Task 1 — projected + fill-only)
- b28a578 (Task 2 — custom strategy)
- 97f0646 (Task 3 — orchestrator + client)
