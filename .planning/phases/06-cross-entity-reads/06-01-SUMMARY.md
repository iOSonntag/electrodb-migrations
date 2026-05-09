---
phase: 06
plan: 01
subsystem: ctx
tags:
  - ctx
  - cross-entity-reads
  - phase-06
  - wave-0
  - spike
dependency_graph:
  requires:
    - src/safety/fingerprint-projection.ts (Phase 1 — fingerprintEntityModel)
    - src/snapshot/read.ts (Phase 1 — readEntitySnapshot)
    - src/snapshot/paths.ts (Phase 1 — entitySnapshotPath)
    - src/errors/classes.ts (Phase 1 — EDBStaleEntityReadError, EDBSelfReadInMigrationError)
    - src/rollback/preconditions.ts (Phase 5 — checkPreconditions, to be extended by 06-05)
    - tests/_helpers/source-scan.ts (Phase 3 — scanFiles, stripCommentLines)
  provides:
    - tests/unit/ctx/entity-clone.spike.test.ts (Research §A4 confirmation — Wave 1 gate)
    - tests/unit/ctx/_helpers.ts (shared stub factories for Phase 6 unit tests)
    - tests/unit/ctx/build-ctx.test.ts (RED tests — unblocked by Plan 06-03)
    - tests/unit/ctx/read-only-facade.test.ts (RED tests — unblocked by Plan 06-02)
    - tests/unit/ctx/source-scan.test.ts (Phase 6 source-scan invariant)
    - tests/unit/rollback/preconditions-ctx08.test.ts (RED tests — unblocked by Plan 06-05)
    - tests/_helpers/sample-migrations/User-reads-Team/ (CTX-01..06 fixture)
    - tests/_helpers/sample-migrations/User-self-read/ (CTX-04 runtime fixture)
  affects:
    - Plan 06-02 (createReadOnlyFacade — unblocked by spike gate)
    - Plan 06-03 (buildCtx — unblocked by spike gate)
    - Plan 06-05 (CTX-08 checkPreconditions extension)
    - Plan 06-06 (integration tests — consume both fixtures)
tech_stack:
  added: []
  patterns:
    - Wave 0 spike test verifying external API behavior before committing to strategy
    - @ts-expect-error on future-module imports as compiler-enforced RED-to-GREEN reminder
    - Named-export barrels with suffix-named factories to avoid import collisions
    - Shared stub factory pattern (mirrors tests/unit/rollback/_stub-service.ts)
key_files:
  created:
    - tests/unit/ctx/entity-clone.spike.test.ts
    - tests/unit/ctx/_helpers.ts
    - tests/unit/ctx/build-ctx.test.ts
    - tests/unit/ctx/read-only-facade.test.ts
    - tests/unit/ctx/source-scan.test.ts
    - tests/unit/rollback/preconditions-ctx08.test.ts
    - tests/_helpers/sample-migrations/User-reads-Team/index.ts
    - tests/_helpers/sample-migrations/User-reads-Team/v1.ts
    - tests/_helpers/sample-migrations/User-reads-Team/v2.ts
    - tests/_helpers/sample-migrations/User-reads-Team/team.ts
    - tests/_helpers/sample-migrations/User-reads-Team/migration.ts
    - tests/_helpers/sample-migrations/User-self-read/index.ts
    - tests/_helpers/sample-migrations/User-self-read/v1.ts
    - tests/_helpers/sample-migrations/User-self-read/v2.ts
    - tests/_helpers/sample-migrations/User-self-read/migration.ts
  modified: []
decisions:
  - "Research §A4 CONFIRMED: new Entity(entity.schema, {client, table}) produces a fully functional clone bound to the new client; facade strategy is sound."
  - "Wave 1 (Plans 06-02 + 06-03) is UNBLOCKED by the spike test result (4/4 assertions passing against real electrodb package)."
  - "Pitfall 1 confirmed non-issue: cloning via new Entity() does NOT mutate the original entity's client reference."
  - "Pitfall 2 confirmed non-issue: query and scan namespace objects are accessible on the cloned entity."
  - "Source-scan invariant armed: src/ctx/ cannot introduce entity.setClient() calls; activates automatically as Wave 1 lands files."
metrics:
  duration_minutes: 7
  tasks_completed: 3
  files_created: 16
  files_modified: 0
  completed_date: "2026-05-09"
---

# Phase 06 Plan 01: Wave 0 Prerequisites Summary

**One-liner:** Wave 0 spike confirms new Entity(schema, config) clone approach is sound — 4/4 gate assertions pass against real electrodb; 16 files created (spike + helpers + RED tests + fixtures).

## Spike Gate Result

**PASS** — Research Assumption A4 is empirically confirmed.

`pnpm vitest run tests/unit/ctx/entity-clone.spike.test.ts` exits **0** with **4/4 assertions passing**.

| Assertion | Result |
|-----------|--------|
| clone.get({id}).params().TableName === 'cloned-table' | PASS |
| clone.query.byId is a function (Pitfall 2 pin) | PASS |
| clone.scan is defined (Pitfall 2 pin) | PASS |
| original.get({id}).params().TableName === 'original-table' after cloning (Pitfall 1 pin) | PASS |

Wave 1 (Plans 06-02 + 06-03) is **UNBLOCKED**.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Wave 0 spike test | 3cabfff | tests/unit/ctx/entity-clone.spike.test.ts |
| 2 | Wave 0 fixtures | e08c7ce | tests/_helpers/sample-migrations/User-reads-Team/ (5), User-self-read/ (4) |
| 3 | RED tests + helpers + source-scan | 29c3891 | tests/unit/ctx/_helpers.ts, build-ctx.test.ts, read-only-facade.test.ts, source-scan.test.ts, tests/unit/rollback/preconditions-ctx08.test.ts |

## File Delta

16 files created (plan target: 16):
- 1 spike test
- 1 shared helpers module
- 1 source-scan invariant test (GREEN at Wave 0)
- 4 RED unit test files (3 in ctx/, 1 in rollback/)
- 9 fixture files (5 User-reads-Team, 4 User-self-read)
- 0 files modified

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm vitest run entity-clone.spike.test.ts` (4/4) | PASS |
| `pnpm tsc --noEmit` | PASS |
| `pnpm vitest run source-scan.test.ts` (GREEN) | PASS |
| `pnpm vitest run build-ctx.test.ts` (RED — module-not-found) | NON-ZERO (expected) |
| `pnpm vitest run read-only-facade.test.ts` (RED — module-not-found) | NON-ZERO (expected) |
| `pnpm vitest run preconditions-ctx08.test.ts` (RED — Step 10 absent) | NON-ZERO (expected) |
| `pnpm vitest run tests/unit/lock/source-scan.test.ts` (existing — unchanged) | PASS |

## Fixture Details

**User-reads-Team** (5 files):
- `v1.ts` — User v1 with `teamId` foreign key (`createUserV1ReadsTeam`)
- `v2.ts` — User v2 with `teamName` denormalized field (`createUserV2ReadsTeam`)
- `team.ts` — Team entity co-located in same table (`createTeamEntityReadsTeam`)
- `migration.ts` — id `20260601000005-User-reads-Team`, `reads: [Team]`, `up()` calls `ctxApi.entity(Team).get().go()`
- `index.ts` — named exports barrel

**User-self-read** (4 files):
- `v1.ts`, `v2.ts` — User v1/v2 entities (`createUserV1SelfRead`, `createUserV2SelfRead`)
- `migration.ts` — id `20260601000006-User-self-read`, NO `reads:`, `up()` calls `ctxApi.entity(<self>)` to trigger CTX-04
- `index.ts` — named exports barrel

## RED Tests State

| File | RED Reason | Unblocked By |
|------|------------|--------------|
| build-ctx.test.ts | `src/ctx/build-ctx.ts` does not exist | Plan 06-03 |
| read-only-facade.test.ts | `src/ctx/read-only-facade.ts` does not exist | Plan 06-02 |
| preconditions-ctx08.test.ts | Step 10 not in checkPreconditions | Plan 06-05 |

The `@ts-expect-error` directives on the future-module imports serve as compiler-enforced reminders: once Wave 1 ships those files, TypeScript will flag each directive as unused — forcing the executor to remove them (proving the modules landed correctly).

## Source-Scan Invariant

`tests/unit/ctx/source-scan.test.ts` enforces:
- No `entity.setClient(` call anywhere in `src/ctx/**/*.ts` (Pitfall 1 guard)

At Wave 0, `src/ctx/` has zero files — the invariant passes trivially but is armed. Once Plans 06-02 and 06-03 land files under `src/ctx/`, any `setClient` call will immediately fail the scan.

## No Known Stubs

All fixture files are fully functional — no placeholder text, no hardcoded empty values that would flow to UI rendering.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced by this plan. All files are test-only. No threat flags.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified:
- tests/unit/ctx/entity-clone.spike.test.ts: FOUND
- tests/unit/ctx/_helpers.ts: FOUND
- tests/unit/ctx/build-ctx.test.ts: FOUND
- tests/unit/ctx/read-only-facade.test.ts: FOUND
- tests/unit/ctx/source-scan.test.ts: FOUND
- tests/unit/rollback/preconditions-ctx08.test.ts: FOUND
- tests/_helpers/sample-migrations/User-reads-Team/index.ts: FOUND
- tests/_helpers/sample-migrations/User-reads-Team/migration.ts: FOUND
- tests/_helpers/sample-migrations/User-self-read/index.ts: FOUND
- tests/_helpers/sample-migrations/User-self-read/migration.ts: FOUND

Commits verified:
- 3cabfff (spike test)
- e08c7ce (fixtures)
- 29c3891 (RED tests + helpers)
