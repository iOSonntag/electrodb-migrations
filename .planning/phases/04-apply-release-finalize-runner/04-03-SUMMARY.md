---
phase: 04-apply-release-finalize-runner
plan: "03"
subsystem: runner
tags: [runner, state-mutation, lock, dynamodb, tdd, run-05, lck-05]

# Dependency graph
requires:
  - phase: 03-internal-entities-lock-guard
    provides: "MigrationsServiceBundle, MIGRATION_STATE_ID, state-mutations pattern (appendInFlight)"

provides:
  - "src/runner/transition-release-to-apply.ts — internal release→apply hand-off verb with runId+lockState WHERE-clause guard"

affects: [04-09-apply-batch, "any plan using the apply-batch loop"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single-entity patch with AND WHERE clause: lockRunId + lockState pinned simultaneously (T-04-03-01 mitigation)"
    - "Runner-internal verb pattern: lives in src/runner/ not src/state-mutations/; NOT re-exported from src/index.ts"
    - "TDD RED→GREEN cycle mirroring appendInFlight shape as the closest analog"

key-files:
  created:
    - src/runner/transition-release-to-apply.ts
    - tests/unit/runner/transition-release-to-apply.test.ts
  modified: []

key-decisions:
  - "migId kept in TransitionReleaseToApplyArgs for call-site symmetry with appendInFlight (both use {runId, migId}), but not read by this verb — documented in JSDoc"
  - "No try/catch — ConditionalCheckFailedException propagates directly to apply-batch outer error handler (same disposition as appendInFlight)"
  - "Verb lives under src/runner/ not src/state-mutations/ because v0.1 has exactly one caller; promote in Phase 5+ if more callers materialize"

patterns-established:
  - "Runner-internal verb: single-entity patch under src/runner/, sole caller is apply-batch.ts, NOT in public src/index.ts"
  - "WHERE clause shape for release→apply: lockRunId AND lockState both pinned to prevent operator unlock racing the apply loop"

requirements-completed: [RUN-05]

# Metrics
duration: 2min
completed: "2026-05-08"
---

# Phase 4 Plan 03: transitionReleaseToApply (Runner-Only) Summary

**TDD-proven `lockState='release'→'apply'` hand-off patch with `lockRunId AND lockState` WHERE clause, scoped to `src/runner/` as an internal-only verb (RUN-05 / LCK-05)**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-08T18:42:43Z
- **Completed:** 2026-05-08T18:44:47Z
- **Tasks:** 2 (RED + GREEN)
- **Files modified:** 2

## Accomplishments

- Implemented `transitionReleaseToApply` verb as a single-entity ElectroDB patch (45 lines, within the ≤45 line success criterion)
- WHERE clause pins `lockRunId=:runId AND lockState='release'` — T-04-03-01 race condition mitigation confirmed by test Cases B+D
- All 6 unit tests green, verifying exact patch shape, ISO-8601 timestamp equality, no add/delete/remove, no transactWrite
- Verb is NOT exported from `src/index.ts` — T-04-03-02 mitigation (internal-only confirmed by grep)
- RUN-05/LCK-05 referenced in JSDoc as required by success criteria

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED | `5440305` — `test(04-03): RED — release→apply hand-off shape (RUN-05)` | PASS — module-not-found failure confirmed |
| GREEN | `51e5804` — `feat(04-03): GREEN — release→apply hand-off (RUN-05)` | PASS — 6/6 tests green |
| REFACTOR | N/A — verb is intentionally minimal | N/A |

## Task Commits

1. **RED: Failing test for transitionReleaseToApply** — `5440305` (test)
2. **GREEN: Implementation of transitionReleaseToApply** — `51e5804` (feat)

## Files Created/Modified

- `src/runner/transition-release-to-apply.ts` — Internal release→apply hand-off verb; 45 lines; exports `transitionReleaseToApply` and `TransitionReleaseToApplyArgs`
- `tests/unit/runner/transition-release-to-apply.test.ts` — 6 unit tests covering patch capture, set fields, timestamp equality, WHERE clause contents, no add/delete/remove, no transactWrite

## Six Test Names

1. `captures exactly one _migration_state patch (no transactWrite)`
2. `set fields are exact: lockState, heartbeatAt, updatedAt`
3. `heartbeatAt equals updatedAt (single 'now' timestamp)`
4. `where condition contains both lockRunId and lockState equality clauses`
5. `no add/delete/remove — standalone set patch only`
6. `does not call transactWrite (single-entity patch only)`

## WHERE-Clause Shape Match Verification

The implementation's WHERE clause:
```typescript
.where(({ lockRunId, lockState }, op) =>
  `${op.eq(lockRunId, args.runId)} AND ${op.eq(lockState, 'release')}`,
)
```

Integration-test reference (`tests/integration/lock/multi-migration-batch.test.ts:91-95`):
```typescript
.where(({ lockRunId, lockState }, op) =>
  `${op.eq(lockRunId, runId)} AND ${op.eq(lockState, 'release')}`)
```

Shapes are byte-for-byte identical (modulo the `args.` prefix on `runId`). The `set` fields `{lockState: 'apply', heartbeatAt: now, updatedAt: now}` also match the integration reference exactly.

## Decisions Made

- Kept `migId` in `TransitionReleaseToApplyArgs` for call-site symmetry with `appendInFlight` — documented in JSDoc that the verb does not read it; Plan 09 (apply-batch) will call `appendInFlight(service, args)` before `transitionReleaseToApply(service, args)` with the same args object
- No try/catch added — same disposition as `appendInFlight`: propagate `ConditionalCheckFailedException` to the apply-batch outer error handler

## Deviations from Plan

None — plan executed exactly as written. The implementation mirrors the specified GREEN code block verbatim.

## Issues Encountered

`pnpm vitest run` failed from the worktree because node_modules is not present in the worktree directory. Resolved by using the direct path to the vitest binary from the main repo (`/Users/oliver/development/Repositories/open-source/electrodb-migrations/node_modules/.bin/vitest`). No code change required.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The module is a pure in-process DDB patch verb with no external surface. Threat register (T-04-03-01, T-04-03-02, T-04-03-03) fully addressed.

## Known Stubs

None.

## Next Phase Readiness

- `transitionReleaseToApply` is ready for consumption by Plan 04-09 (`apply-batch.ts`)
- The `tests/unit/runner/` directory is established and can host stubs for subsequent runner plans
- No blockers

## Self-Check: PASSED

- src/runner/transition-release-to-apply.ts — FOUND (45 lines, ≤45 criterion met)
- tests/unit/runner/transition-release-to-apply.test.ts — FOUND
- .planning/phases/04-apply-release-finalize-runner/04-03-SUMMARY.md — FOUND
- RED commit 5440305 — FOUND
- GREEN commit 51e5804 — FOUND
- transitionReleaseToApply NOT in src/index.ts — CONFIRMED
- RUN-05/LCK-05 in JSDoc — CONFIRMED (line 15)

---
*Phase: 04-apply-release-finalize-runner*
*Completed: 2026-05-08*
