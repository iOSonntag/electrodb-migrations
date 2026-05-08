---
phase: 04-apply-release-finalize-runner
plan: "08"
subsystem: runner
tags:
  - runner
  - orchestrator
  - apply-flow
  - lock
  - safety
  - phase-04
  - wave-2

requires:
  - phase: 04-01
    provides: runner stub service (makeRunnerStubService)
  - phase: 04-02
    provides: count-audit accumulator (createCountAudit, RUN-04)
  - phase: 04-03
    provides: transitionReleaseToApply (runner-internal verb)
  - phase: 04-05
    provides: batchFlushV2 marshal+retry adapter (RUN-03)
  - phase: 03
    provides: acquireLock, startLockHeartbeat, transitionToReleaseMode, markFailed (Phase 3 verbs)

provides:
  - "src/runner/apply-flow.ts — applyFlow (single-migration orchestrator) + applyFlowScanWrite (scan/write half)"
  - "src/runner/sleep.ts — trivial setTimeout Promise wrapper (LCK-04 acquireWaitMs window)"
  - "src/runner/scan-pipeline.ts — cursor-loop AsyncGenerator iterating migration.from via ElectroDB scan"
  - "tests/unit/runner/apply-flow.test.ts — 8 stub-based unit tests pinning call order, error paths, try/finally"

affects:
  - "04-09 apply-batch — uses applyFlowScanWrite (second-half handoff) for migration #2..N"
  - "04-10 finalize-flow — sibling orchestrator pattern from apply-flow"
  - "04-14a integration tests — wire-up against DDB Local"
  - "04-12 apply CLI command — calls applyFlow"

tech-stack:
  added: []
  patterns:
    - "acquireLock → startHeartbeat → sleep(acquireWaitMs) → scan/write → transitionRelease composition order (non-negotiable)"
    - "try/finally sched.stop() on every exit path (Pitfall 4 / CR-04 defense)"
    - "OQ-2 disposition: up() returning null/undefined → skipped count (not failed)"
    - "RUN-04 audit.assertInvariant() called BEFORE transitionToReleaseMode"
    - "RUN-08: up() throw increments failed and re-throws; markFailed called in catch (.catch() to swallow markFailed rejection)"
    - "vi.hoisted() pattern for vitest module mock initialization ordering"

key-files:
  created:
    - "src/runner/apply-flow.ts"
    - "src/runner/scan-pipeline.ts"
    - "src/runner/sleep.ts"
    - "tests/unit/runner/apply-flow.test.ts"
  modified: []

key-decisions:
  - "sleep.ts and scan-pipeline.ts were co-created in this plan (not pre-existing from plan 04-07) because both are parallel wave-2 plans running concurrently — Rule 3 deviation (blocking dependency)"
  - "applyFlow docstring trimmed to stay ≤120 lines while preserving LCK-04 and Pitfall 4 inline comments (load-bearing safety reminders)"
  - "vi.hoisted() used instead of top-level const + vi.mock factory to avoid ReferenceError hoisting issue in vitest 2.x"
  - "AF-7 specifically asserts markFailed NOT called when acquireLock fails — defends regression where a future refactor wraps entire function in catch"
  - "AF-4 audit check: scanned=2, migrated=0, skipped=0, failed=1 — first record triggers batchFlushV2, second throws in up()"

patterns-established:
  - "LCK-04 sleep seam: always call sleep(config.lock.acquireWaitMs) between acquireLock and first scan"
  - "try/finally heartbeat-stop: sched.stop() in finally block regardless of success or failure"
  - "markFailed in catch: .catch() wrapper around markFailed to prevent double-throw masking the original error"
  - "Two-half split (applyFlow / applyFlowScanWrite): enables apply-batch to re-use scan/write without re-acquiring lock"

requirements-completed:
  - RUN-01
  - RUN-02
  - RUN-04
  - RUN-08

duration: 10min
completed: "2026-05-08"
---

# Phase 4 Plan 08: applyFlow Orchestrator Summary

**`applyFlow` single-migration orchestrator composing Phase 3 lock verbs + Phase 1 batch-write retry into the canonical scan-v1→transform→write-v2→transition sequence, with LCK-04 sleep enforcement and try/finally heartbeat-stop on every exit path**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-08T19:36:33Z
- **Completed:** 2026-05-08T19:46:00Z
- **Tasks:** 2 (+ 1 Rule 3 auto-fix for parallel wave-2 dependencies)
- **Files created:** 4
- **Tests:** 8 new (656 total unit tests passing)

## Accomplishments

- `applyFlow` orchestrator implementing RUN-01/02/04/08 with non-negotiable composition order
- `applyFlowScanWrite` second-half split for apply-batch to reuse without re-acquiring lock
- `sleep.ts` and `scan-pipeline.ts` created (parallel wave-2 plan dependency, Rule 3 auto-fix)
- 8 stub-based unit tests pinning call order via `mock.invocationCallOrder`, error paths, and try/finally guarantees
- 656/656 unit tests passing; `pnpm tsc --noEmit` exits 0

## Task Commits

1. **Task 1: applyFlow orchestrator + scan-pipeline + sleep** - `79f072c` (feat)
2. **Task 2: unit tests AF-1..AF-8** - `bff286a` (test)

## Unit Test Names (AF-1..AF-8)

| ID | Test Name |
|----|-----------|
| AF-1 | happy path — acquireLock → startLockHeartbeat → sleep → scan → transitionToReleaseMode → sched.stop |
| AF-2 | acquireWaitMs forwarded literally to sleep() |
| AF-3 | transitionToReleaseMode receives accurate count-audit snapshot |
| AF-4 | RUN-08 fail-fast — up() throw → markFailed called; transitionToReleaseMode NOT called |
| AF-5 | sched.stop() runs exactly once on success AND exactly once on failure |
| AF-6 | count-audit invariant violation → markFailed + sched.stop; error contains RUN-04 |
| AF-7 | acquireLock failure — no startLockHeartbeat, no markFailed; error re-thrown |
| AF-8 | applyFlowScanWrite called directly — no acquireLock, no startLockHeartbeat, no sleep |

## LCK-04 Sleep Reachability Note

| Invocation path | LCK-04 sleep present |
|-----------------|----------------------|
| `applyFlow(args)` — single migration, first-ever | YES — `await sleep(config.lock.acquireWaitMs)` between acquireLock and first iterateV1Records call |
| `applyFlowScanWrite(args)` — called by apply-batch for migration #2..N | NO — intentional. The lock is already held in `apply` state (transitioned by `transitionReleaseToApply`); the guard caches have already been stale-cut by the first migration's sleep. The `transitionReleaseToApply` sets a fresh `heartbeatAt` but does not sleep — this is documented in plan 04-09's spec. |

The `applyFlow` path is the ONLY path that runs the LCK-04 sleep, and it runs it on EVERY apply invocation (per lock acquire). This is the correct behavior.

## Files Created/Modified

- `src/runner/apply-flow.ts` (119 lines) — `applyFlow` + `applyFlowScanWrite` orchestrator
- `src/runner/scan-pipeline.ts` (49 lines) — `iterateV1Records` cursor-loop AsyncGenerator
- `src/runner/sleep.ts` (14 lines) — `sleep(ms)` setTimeout Promise wrapper
- `tests/unit/runner/apply-flow.test.ts` (314 lines) — 8 stub-based orchestrator tests

## Decisions Made

- **vi.hoisted() pattern:** Used `vi.hoisted()` to export mock function references before the `vi.mock()` factory callbacks resolve. This is the correct vitest 2.x pattern for module mocks that need observable call-order tracking via `invocationCallOrder`.
- **Two-half split:** `applyFlow` = lock half + `applyFlowScanWrite`; `applyFlowScanWrite` = scan/write half. This design enables apply-batch (plan 04-09) to reuse the scan/write loop without re-acquiring the lock between migrations.
- **markFailed `.catch()` wrapper:** `markFailed` errors are swallowed with a `console.error` diagnostic. This matches Phase 3's `heartbeat.ts` onAbort pattern (CR-04) — the catch exists to prevent a markFailed rejection from masking the original runner error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created scan-pipeline.ts and sleep.ts (parallel wave-2 dependency)**
- **Found during:** Task 1 (implementing apply-flow.ts)
- **Issue:** `scan-pipeline.ts` and `sleep.ts` are specified as outputs of plan 04-07, which is a parallel wave-2 plan. At the worktree base commit (25cf9b5, plan 04-04 merge), neither file existed. apply-flow.ts imports both directly.
- **Fix:** Created both files verbatim from the 04-07 PLAN.md specification (the plan's `<action>` section provides the exact implementation). Both files are identical to what plan 04-07 would produce.
- **Files created:** `src/runner/sleep.ts`, `src/runner/scan-pipeline.ts`
- **Verification:** `pnpm tsc --noEmit` exits 0; all 656 unit tests pass
- **Committed in:** 79f072c (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking dependency from parallel wave-2 plan)
**Impact on plan:** Required for compilation. Files are identical to what plan 04-07 specifies; no scope creep.

## Issues Encountered

None beyond the blocking dependency noted above.

## Known Stubs

None — `applyFlow` composes real Phase 3 verbs and real Phase 1 batch-write retry. No placeholder values or TODO stubs.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced beyond what is documented in the plan's `<threat_model>`. The safety invariants (T-04-08-01 through T-04-08-05) are all enforced:
- T-04-08-01: LCK-04 sleep enforced (AF-2 pins value)
- T-04-08-02: Pitfall 4 try/finally (AF-5 enforces)
- T-04-08-03: RUN-04 assertInvariant before transition (AF-6 enforces)
- T-04-08-04: markFailed on every up-throw (AF-4 enforces)
- T-04-08-05: accepted (heartbeat scheduler handles stale-takeover defense)

## Next Phase Readiness

- `applyFlowScanWrite` is ready for plan 04-09 (apply-batch) to call as the scan/write half
- `iterateV1Records` and `batchFlushV2` composition is proven in unit tests
- Integration verification in plan 04-14a against DDB Local is the next gate

---
*Phase: 04-apply-release-finalize-runner*
*Completed: 2026-05-08*
