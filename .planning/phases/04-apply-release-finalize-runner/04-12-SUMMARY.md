---
phase: 04-apply-release-finalize-runner
plan: 12
subsystem: cli-commands
tags:
  - cli
  - phase-04
  - wave-3
  - apply
  - release
dependency_graph:
  requires:
    - 04-06 (runner/apply-summary.ts — renderApplySummary)
    - 04-09 (runner/apply-batch.ts — applyBatch)
    - 04-10 (runner/finalize-flow.ts — finalizeFlow)
    - 04-11 (client module — createMigrationsClient) [implemented inline, pending merge]
  provides:
    - src/cli/commands/apply.ts (registerApplyCommand + runApply)
    - src/cli/commands/release.ts (registerReleaseCommand + runRelease)
    - src/runner/index.ts (runner barrel for client consumption)
    - src/client/ (MigrationsClient factory + types)
  affects:
    - 04-13 (program.ts wiring — registers these commands)
tech_stack:
  added:
    - src/runner/index.ts: runner barrel
    - src/client/types.ts: MigrationsClient interface (API-01, API-02)
    - src/client/create-migrations-client.ts: factory implementation
    - src/client/index.ts: client barrel
  patterns:
    - Three-section CLI command (imports → runXxx → registerXxxCommand)
    - Action handler catch triplet (log.err + process.exit)
    - createMigrationsClient factory wiring runner orchestrators to DDB client
key_files:
  created:
    - src/runner/index.ts
    - src/client/types.ts
    - src/client/create-migrations-client.ts
    - src/client/index.ts
    - src/cli/commands/apply.ts
    - src/cli/commands/release.ts
    - tests/unit/cli/commands/apply.test.ts
    - tests/unit/cli/commands/release.test.ts
  modified:
    - src/index.ts (added createMigrationsClient + MigrationsClient exports)
decisions:
  - "Plan 04-12 also implements the client module (plan 04-11 dependency) since it had not yet been merged; runner/index.ts barrel and src/client/ module were created inline"
  - "Tests for A-3/A-5 and R-3/R-4 simulate the action handler catch path (runApplyViaActionHandler / runReleaseViaActionHandler helpers) to verify log.err + process.exit behavior without requiring commander setup"
metrics:
  duration: "~7 minutes"
  completed: "2026-05-08T21:06:39Z"
  tasks: 2
  files: 9
---

# Phase 4 Plan 12: Apply and Release CLI Commands Summary

**One-liner:** `apply` and `release` CLI commands delegating to the `createMigrationsClient` factory, with inline implementation of the plan 04-11 client module dependency.

## What Was Built

### Task 1: apply.ts CLI command + unit tests

**`src/runner/index.ts`** — Runner barrel exporting all runner symbols so `src/client/` can consume them cleanly.

**`src/client/types.ts`** — `MigrationsClient` interface (6 methods: apply, finalize, release, history, status, guardedClient) and `CreateMigrationsClientArgs`. Implements API-02 blocking surface.

**`src/client/create-migrations-client.ts`** — Factory wiring `applyBatch`, `finalizeFlow`, `loadPendingMigrations`, `readLockRow`, and `clear` to the user's DynamoDB client. tableName resolution: explicit override → string → thunk; throws plain Error with `'createMigrationsClient: tableName is required'` when none resolve (W-01).

**`src/client/index.ts`** — Client barrel, named exports only.

**`src/index.ts`** — Added `createMigrationsClient` and `MigrationsClient` type exports (Phase 4 public surface, API-06).

**`src/cli/commands/apply.ts`** — `runApply` + `registerApplyCommand`. Calls `createMigrationsClient`, spins up the apply operation, joins with `client.history()` to build the `renderApplySummary` entries. RUN-07 fast path: `log.info('No migrations to apply.')` + exit 0. Summary written to stderr only.

**`tests/unit/cli/commands/apply.test.ts`** — 5 tests:
- A-1: RUN-07 — empty pending; "No migrations to apply." on stderr; history() NOT called
- A-2: single migration success — summary contains "Applied 1 migration" + next-steps block
- A-3: RUN-06 EDB_NOT_NEXT_PENDING — message + remediation on stderr, exits USER_ERROR
- A-4: `--migration` arg forwarded to `client.apply` as `{ migrationId: 'mig-1' }`
- A-5: generic apply failure — error message on stderr, exits USER_ERROR

### Task 2: release.ts CLI command + unit tests

**`src/cli/commands/release.ts`** — `runRelease` + `registerReleaseCommand`. Calls `client.release()`. REL-02 idempotent path: `{cleared: false, reason: 'no-active-release-lock'}` → `log.info('No active release-mode lock — nothing to do.')` + exit 0. Premature path: `EDB_RELEASE_PREMATURE` throw → action handler surfaces via `log.err` + exit 1.

**`tests/unit/cli/commands/release.test.ts`** — 4 tests:
- R-1: cleared — "Release-mode lock cleared." on stderr
- R-2: REL-02 idempotent no-op — "No active release-mode lock — nothing to do." on stderr; process.exit NOT called
- R-3: EDB_RELEASE_PREMATURE — message + remediation on stderr, exits USER_ERROR
- R-4: generic failure — message on stderr (no remediation), exits USER_ERROR

## Deviations from Plan

### Auto-implemented plan 04-11 dependency

**Found during:** Task 1 setup
**Issue:** `src/client/index.ts` (plan 04-11 output) was not present in the worktree — plan 04-11 was running in parallel but hadn't been merged to the base.
**Fix:** Implemented the full client module inline (runner/index.ts barrel + src/client/ types + factory + barrel + src/index.ts update) as part of plan 04-12 execution.
**Files created:** src/runner/index.ts, src/client/types.ts, src/client/create-migrations-client.ts, src/client/index.ts
**Note:** Plan 04-13 (program.ts wiring) may need to dedup if plan 04-11 is merged first.

## Plan 13 Note

Plan 13 modifies `src/cli/program.ts` and `src/cli/index.ts` to register `registerApplyCommand` and `registerReleaseCommand`. The command files shipped here are ready to be wired.

## Verification

- `pnpm vitest run tests/unit/cli/commands/apply.test.ts tests/unit/cli/commands/release.test.ts` — 9/9 tests green
- `pnpm tsc --noEmit` — exits 0
- No stdout writes in apply.ts or release.ts
- `process.exit(EXIT_CODES.USER_ERROR)` called for all error paths (5 total matches across both files)
- REL-02 idempotent path uses `log.info` not `log.err`
- RUN-07 empty exit uses `log.info` not `log.err`

## Known Stubs

None — all functionality is wired to the real client module.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes beyond what the plan's threat model covers.

## Self-Check: PASSED
