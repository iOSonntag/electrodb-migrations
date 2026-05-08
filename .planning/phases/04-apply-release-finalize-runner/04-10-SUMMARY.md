---
phase: 04-apply-release-finalize-runner
plan: 10
subsystem: runner/finalize
tags:
  - runner
  - orchestrator
  - finalize
  - phase-04
  - wave-2
dependency-graph:
  requires:
    - 04-02 (count-audit accumulator — RUN-04)
    - 04-07 (scan-pipeline + sleep utilities — RUN-01 + LCK-04)
  provides:
    - finalizeFlow orchestrator (FIN-01/03/04)
    - iterateV1Records AsyncGenerator (RUN-01) [also in 04-07 on main; included here for worktree]
    - sleep LCK-04 helper [also in 04-07 on main; included here for worktree]
  affects:
    - Phase 5 (FIN-04 irreversibility — _migrations.hasDown used by RBK-09)
    - Plan 04-14b (FIN-01/03 integration tests on DDB Local)
tech-stack:
  added: []
  patterns:
    - AsyncGenerator cursor-loop pagination (scan-pipeline.ts)
    - Duck-typed ConditionalCheckFailedException check (isConditionalCheckFailed)
    - try/finally heartbeat-stop (Pitfall 4 guard)
    - Two-step finalize: patch _migrations + clear lock (T-04-10-03 mitigation)
key-files:
  created:
    - src/runner/finalize-flow.ts
    - src/runner/scan-pipeline.ts
    - src/runner/sleep.ts
    - tests/unit/runner/finalize-flow.test.ts
  modified: []
decisions:
  - "audit.addMigrated reused as 'deleted' slot for finalize (option a over addDeleted) — keeps count-audit module zero-changes"
  - "LCK-04 sleep retained in finalizeFlow even though finalize is non-gating (Decision A7) — defensive cleanup window for stale-cache processes"
  - "Two-step post-loop (patch THEN clear) not transactWrite — independent conditions; if clear fails, migration is still correctly finalized (T-04-10-03)"
metrics:
  duration: "~6 minutes"
  completed: "2026-05-08"
  tasks: 2
  files: 4
---

# Phase 04 Plan 10: finalizeFlow Orchestrator Summary

**One-liner:** `finalizeFlow` with `mode='finalize'` lock + scan-delete loop + Pitfall 7 CCF skip + two-step patch/clear post-loop

## What Was Built

### Task 1: `src/runner/finalize-flow.ts` (commit 8e95dde)

Implements `finalizeFlow` — the FIN-01/03/04 orchestrator for `electrodb-migrations finalize <id>`. Same shape as `applyFlow` but with three structural differences per the plan:

1. `acquireLock(mode='finalize')` — maintenance-mode lock. Per Decision A7, `'finalize'` is NOT in `GATING_LOCK_STATES` so app traffic continues (avoids downtime for the post-bake delete-v1 step).

2. Per-record action is `migration.from.delete(record).go()` instead of transform + write-v2.

3. Post-loop: patch `_migrations.status='finalized'` THEN `clear({runId})` (two separate writes, not transactWrite — see T-04-10-03 mitigation below).

Also committed in the same task (Rule 3 — missing dependencies from plan 07 that were not in the worktree):
- `src/runner/scan-pipeline.ts` — `iterateV1Records` AsyncGenerator (RUN-01)
- `src/runner/sleep.ts` — one-shot `Promise<void>` setTimeout wrapper (LCK-04)

### Task 2: `tests/unit/runner/finalize-flow.test.ts` (commit adb1b61)

9 unit tests covering all 8 plan-specified cases (FF-7 has two sub-cases):

| Test | Name | Status |
|------|------|--------|
| FF-1 | acquireLock called with `mode: 'finalize'` | PASS |
| FF-2 | Call order: acquireLock → heartbeat → sleep → scan → patch → clear → stop | PASS |
| FF-3 | Empty scan — patch+clear still fire; counts all zero | PASS |
| FF-4 | Pitfall 7 — CCF on 2nd record counted as skipped:1 | PASS |
| FF-5 | Unexpected delete error — markFailed called, clear NOT called | PASS |
| FF-6 | assertInvariant fires before patch+clear | PASS |
| FF-7a | sched.stop called once on success path | PASS |
| FF-7b | sched.stop called once on failure path | PASS |
| FF-8 | FIN-04 — no auto-rollback verb called on success | PASS |

## Key Decisions

### 1. `audit.addMigrated` Reuse (option a)

The count-audit module (Plan 04-02) uses "migrated" terminology from apply semantics. For finalize, the same slot means "deleted". Two options:

- **Option (a)** — reuse `addMigrated` as the "completed-action" slot (chosen). Keeps the audit module zero-changes; semantics documented in `finalize-flow.ts` JSDoc.
- **Option (b)** — add a new `addDeleted(n)` method to count-audit. Cleaner naming but couples the audit module to finalize semantics.

**Decision: option (a)** — zero-change to existing modules, with JSDoc clarifying the reuse.

### 2. LCK-04 Sleep in finalizeFlow (Non-gating)

`finalizeFlow` includes `await sleep(config.lock.acquireWaitMs)` between `acquireLock` and the first scan, even though finalize is non-gating (Decision A7). This mirrors the same sleep in `applyFlow`. The sleep is retained as:
- A defensive cleanup window for any guarded process with a stale cache
- Mirror of the `CLAUDE.md` constraint: "`guard.cacheTtlMs < lock.acquireWaitMs` is validated at start; framework refuses to run otherwise" — the invariant is inherited by finalizeFlow
- Noted in JSDoc: "even though finalize is non-gating (Decision A7), the sleep allows stale-cached guarded processes time to refresh"

### 3. Two-Step Post-Loop (patch + clear separately)

`migrations.patch({status:'finalized'})` and `clear({runId})` are two separate writes, not a transactWrite. Rationale (T-04-10-03):
- If `clear`'s WHERE clause fails after the patch succeeds, the migration row IS correctly `finalized`
- Operator can run `unlock` to recover — no half-finalized state
- Contrast: `apply` uses `transitionToReleaseMode` (3-item transactWrite) because apply's atomicity invariant covers both the migration row AND the lock state in one operation

## Deviations from Plan

### [Rule 3 — Blocking Issue] scan-pipeline.ts and sleep.ts not in worktree

**Found during:** Task 1 implementation
**Issue:** The worktree (branched from commit `25cf9b5`) did not include `scan-pipeline.ts` or `sleep.ts`, which were created by plan 07 in commit `c65122a` on the main branch AFTER this worktree was created. Both are required imports by `finalize-flow.ts`.
**Fix:** Created both files in the worktree using the same implementations as the main branch (verified via git show c65122a).
**Files modified:** `src/runner/scan-pipeline.ts`, `src/runner/sleep.ts`
**Commit:** 8e95dde (bundled with finalize-flow.ts in the same task commit)

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The `finalizeFlow` orchestrator composes existing verbs (`acquireLock`, `startLockHeartbeat`, `clear`, `markFailed`) without adding new surface. The `isConditionalCheckFailed` helper is a pure duck-typed check with no I/O.

## Known Stubs

None — `finalizeFlow` is fully wired to the existing lock + heartbeat + clear + scan-pipeline primitives.

## Self-Check: PASSED

Files exist:
- `src/runner/finalize-flow.ts` ✓ (121 lines, ≤140 requirement met)
- `src/runner/scan-pipeline.ts` ✓
- `src/runner/sleep.ts` ✓
- `tests/unit/runner/finalize-flow.test.ts` ✓

Commits exist:
- 8e95dde: feat(04-10): implement finalizeFlow orchestrator ✓
- adb1b61: test(04-10): unit tests for finalizeFlow ✓

Test results: 9/9 PASS (`pnpm vitest run tests/unit/runner/finalize-flow.test.ts`)
TypeScript: `pnpm tsc --noEmit` exits 0
