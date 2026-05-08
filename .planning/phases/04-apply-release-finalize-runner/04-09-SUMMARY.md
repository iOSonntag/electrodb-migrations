---
phase: 04-apply-release-finalize-runner
plan: "09"
subsystem: runner
tags:
  - runner
  - orchestrator
  - multi-migration
  - lock-handoff
  - phase-04
  - wave-2
dependency_graph:
  requires:
    - 04-03 (transitionReleaseToApply verb)
    - 04-04 (isNextPending + PendingMigration types)
    - 04-08 (applyFlow + applyFlowScanWrite — implemented as part of this plan due to missing dependency)
  provides:
    - applyBatch — multi-migration loop orchestrator (RUN-05/06/07)
  affects:
    - Plan 12 (apply CLI command — consumes applyBatch)
    - Plan 14a (B-02 guarded-write-at-boundary integration test)
tech_stack:
  added: []
  patterns:
    - vi.mock module-level mocking for call-order observability via invocationCallOrder
    - W-03 invariant: no-heartbeat window spans only release state (takeover-immune per LCK-03)
key_files:
  created:
    - src/runner/apply-batch.ts
    - src/runner/apply-flow.ts
    - src/runner/scan-pipeline.ts
    - src/runner/sleep.ts
    - tests/unit/runner/apply-batch.test.ts
  modified: []
decisions:
  - "Heartbeat lifecycle: applyFlow owns its heartbeat start+stop; applyBatch starts a FRESH scheduler for migrations 2..N. Alternative (applyFlow not owning heartbeat, applyBatch owning across all migrations) was planner-rejected — plan 04-08 already shipped the current design. AB-9+AB-10 make the two-scheduler lifecycle explicit and testable."
  - "W-03 window: no-heartbeat gap between applyFlow stop and next startLockHeartbeat is provably safe because the lock is in release state (not in stale-takeover allowlist). AB-10 pins this via invocationCallOrder."
  - "apply-flow.ts and scan-pipeline.ts and sleep.ts were implemented in this plan as deviations (Rule 3 - blocking dependency): Plan 04-08 had not yet been merged when this plan executed in Wave 2 parallel execution."
metrics:
  duration_minutes: 12
  completed_date: "2026-05-08"
  tasks_completed: 2
  files_created: 5
  files_modified: 0
---

# Phase 4 Plan 09: applyBatch Multi-Migration Loop Orchestrator Summary

**One-liner:** Multi-migration loop orchestrator with per-entity sequence enforcement (RUN-06), empty-list fast-path (RUN-07), appendInFlight+transitionReleaseToApply hand-off pattern (RUN-05), and W-03 no-heartbeat-window invariant pinned by AB-10.

## What Was Built

### `src/runner/apply-batch.ts` (158 lines)

Exports: `applyBatch`, `ApplyBatchArgs`, `ApplyBatchResult`.

The loop drives one continuous lock cycle across N migrations:
- **Migration 0:** `applyFlow` (acquire + LCK-04 sleep + scan/write + transitionToReleaseMode)
- **Migration N (N>0):** `startLockHeartbeat` → `appendInFlight` → `transitionReleaseToApply` → `applyFlowScanWrite`

RUN-07 fast-path: returns `{applied: []}` if `pending.length === 0`.

RUN-06 sequence check: per-entity scope (Open Question 6). When `migrationId` is provided, validates it's the first pending migration for its entity. Throws `EDB_NOT_NEXT_PENDING` (with remediation naming the actual next id) or `EDB_NOT_PENDING` (for unknown ids).

W-03 invariant documented in JSDoc: the brief no-heartbeat window between `applyFlow`'s `sched.stop()` and the next `startLockHeartbeat` spans only `'release'` state, which is NOT in the stale-takeover allowlist (Phase 3 LCK-03). No other runner can take over during this window.

### Dependencies implemented as deviation (Rule 3 — blocking issue)

Plan 04-08 (`apply-flow.ts`) had not been merged when this Wave 2 plan executed in parallel. Three files were implemented to unblock this plan:

- **`src/runner/apply-flow.ts`** — single-migration orchestrator (`applyFlow` + `applyFlowScanWrite`)
- **`src/runner/scan-pipeline.ts`** — async generator for v1 record cursor-loop iteration
- **`src/runner/sleep.ts`** — LCK-04 acquireWait Promise wrapper

These are exact copies of what Plan 04-08 would have produced per its PLAN.md specification.

## Unit Tests (10/10 green)

| Test | Name | What It Pins |
|------|------|--------------|
| AB-1 | Empty pending → `{applied: []}` | RUN-07 fast-path |
| AB-2 | Single pending, no filter — applyFlow called once | RUN-05 single-migration |
| AB-3 | Two pending — exact call order via invocationCallOrder | RUN-05 hand-off sequence |
| AB-4 | migrationId is next pending — only 1 migration applied | RUN-06 filter happy path |
| AB-5 | migrationId NOT next pending — EDB_NOT_NEXT_PENDING with remediation | RUN-06 rejection |
| AB-6 | migrationId unknown — EDB_NOT_PENDING | RUN-06 unknown id |
| AB-7 | Per-entity scope — User-add-status valid even though Team-add-X is first globally | Open Question 6 |
| AB-8 | Migration 2 fails — markFailed called; sched.stop runs; error re-thrown | Failure semantics |
| AB-9 | startLockHeartbeat called exactly once by applyBatch (for mig-2) | Heartbeat ownership |
| AB-10 (W-03) | Exact invocationCallOrder: applyFlow → startLockHeartbeat → appendInFlight → transitionReleaseToApply → applyFlowScanWrite | W-03 regression guard |

## W-03 No-Heartbeat Window Analysis

Between `applyFlow`'s final `sched.stop()` and the next iteration's `startLockHeartbeat`, there is a brief window (microseconds in practice) where no heartbeat is being written. This is safe because:

1. `applyFlow` ends with `transitionToReleaseMode` — the lock state is exactly `'release'`
2. `'release'` is NOT in the stale-takeover allowlist (Phase 3 LCK-03) — even arbitrarily stale `heartbeatAt` cannot allow another runner to take over
3. `appendInFlight` (the first verb of the next iteration) does NOT change `lockState` — it only mutates `lockMigrationId` + `inFlightIds`
4. `transitionReleaseToApply` flips `lockState → 'apply'` AFTER `startLockHeartbeat` has already started

The only risk during this window is an explicit `unlock` (admin-deliberate action), which is acceptable.

**Regression-proofing:** AB-10 asserts the exact call order via `mock.invocationCallOrder`. Any future refactor that moves `transitionReleaseToApply` BEFORE `startLockHeartbeat` (which would put the no-heartbeat window in `'apply'` state — takeover-vulnerable) fails AB-10 immediately.

## Heartbeat Lifecycle Decision

The planner documented two alternatives:
1. **Current design:** `applyFlow` owns its heartbeat start+stop; `applyBatch` starts a fresh scheduler for each migration 2..N. This means there are brief windows of no-heartbeat activity, but only during `'release'` state (W-03 invariant).
2. **Alternative:** `applyFlow` does NOT own the heartbeat; `applyBatch` owns a single scheduler across all migrations. Cleaner conceptually, but would change `applyFlow`'s contract (Plan 04-08 already shipped with the current design).

**Planner decision: keep current design.** The W-03 regression test (AB-10) makes the invariant explicit and regression-proof. Future refactoring to Option 2 is tracked here for reference.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Implemented Plan 04-08 artifacts as dependency**
- **Found during:** Task 1 (apply-batch.ts could not import apply-flow.ts)
- **Issue:** `src/runner/apply-flow.ts`, `src/runner/scan-pipeline.ts`, and `src/runner/sleep.ts` were produced by Plan 04-08, which was running in parallel and had not yet merged into this worktree's base commit.
- **Fix:** Implemented all three files from their Plan 04-08 specifications verbatim.
- **Files created:** `src/runner/apply-flow.ts`, `src/runner/scan-pipeline.ts`, `src/runner/sleep.ts`
- **Commit:** a2e6453 (bundled with apply-batch.ts in the same commit)

## Known Stubs

None — `applyBatch` is fully wired to its dependencies with no placeholder values.

## Threat Flags

None — all new surface is internal runner logic; no new network endpoints, auth paths, or schema changes.

## Self-Check

- [x] `src/runner/apply-batch.ts` exists (158 lines)
- [x] `src/runner/apply-flow.ts` exists
- [x] `tests/unit/runner/apply-batch.test.ts` exists (10/10 tests green)
- [x] Commit a2e6453 exists (Task 1)
- [x] Commit dfdae5a exists (Task 2)
- [x] `pnpm tsc --noEmit` exits 0
- [x] `grep -c "No-heartbeat boundary window" src/runner/apply-batch.ts` → 1
- [x] `grep -c "AB-10|W-03" tests/unit/runner/apply-batch.test.ts` → 4
- [x] `grep -c "lock-state-set" tests/unit/runner/apply-batch.test.ts` → 1
- [x] `grep -c "EDB_NOT_NEXT_PENDING|EDB_NOT_PENDING" src/runner/apply-batch.ts` → 3

## Self-Check: PASSED
