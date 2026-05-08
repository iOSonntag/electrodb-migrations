---
phase: 04-apply-release-finalize-runner
plan: 07
subsystem: runner
tags:
  - runner
  - scan
  - phase-04
  - wave-2

dependency_graph:
  requires:
    - 04-01 (tests/unit/runner/_stub-service.ts, Wave 0 spike confirming Assumption A4)
    - src/migrations/types.ts (Migration, AnyElectroEntity)
    - src/safety/heartbeat-scheduler.ts (setTimeout-chain pattern reference for sleep rationale)
  provides:
    - src/runner/sleep.ts (sleep(ms) Promise<void> utility)
    - src/runner/scan-pipeline.ts (iterateV1Records AsyncGenerator, IterateV1RecordsOptions)
  affects:
    - 04-08 apply-flow.ts (imports sleep + iterateV1Records)
    - 04-10 finalize-flow.ts (imports iterateV1Records)

tech_stack:
  added: []
  patterns:
    - AsyncGenerator cursor-loop over ElectroDB entity.scan.go
    - One-shot setTimeout sleep (distinct from self-rescheduling heartbeat chain)

key_files:
  created:
    - src/runner/sleep.ts
    - src/runner/scan-pipeline.ts
    - tests/unit/runner/sleep.test.ts
    - tests/unit/runner/scan-pipeline.test.ts
  modified: []

decisions:
  - "Wave 0 spike path confirmed: entity.scan chain used directly (no raw ScanCommand fallback) — Assumption A4 CONFIRMED in Plan 04-01"
  - "Empty pages not yielded but cursor always advances — preserves pagination state and ensures onPage fires consistently"
  - "onPage fires once per cursor advance (whether or not records were yielded) — gives heartbeat scheduler event-loop ticks on sparse tables"
  - "scan-pipeline.ts standalone helper file (not method on a class) — mirrors count-audit.ts, batch-flush.ts pattern; composable by apply-flow + finalize-flow"

metrics:
  duration: "~2 minutes"
  completed_date: "2026-05-08"
  tasks_completed: 2
  tasks_total: 2
  files_created: 4
  files_modified: 0
---

# Phase 04 Plan 07: Scan-Pipeline + Sleep Utilities Summary

**One-liner:** Cursor-based AsyncGenerator (`iterateV1Records`) over ElectroDB's identity-stamp-filtered `entity.scan.go` chain, plus a one-shot `sleep(ms)` LCK-04 primitive — both source-scan invariant compliant, 7/7 tests green.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | sleep.ts + unit tests | c65122a | src/runner/sleep.ts, tests/unit/runner/sleep.test.ts |
| 2 | scan-pipeline.ts + unit tests | 5a4cb9b | src/runner/scan-pipeline.ts, tests/unit/runner/scan-pipeline.test.ts |

## Wave 0 Spike Path

**Pre-flight confirmed:** Plan 04-01 SUMMARY records Assumption A4 as CONFIRMED. `entity.scan.go()` filters by `__edb_e__`/`__edb_v__` identity stamps in single-table-design fixtures. The ElectroDB `entity.scan` chain is used directly in `scan-pipeline.ts` — no raw `ScanCommand` + manual `FilterExpression` fallback needed (RESEARCH §Alternatives Considered row 1 is NOT used).

## Test Names (7 total)

| Test ID | Description |
|---------|-------------|
| SLP-1 | sleep(0) resolves |
| SLP-2 | sleep(50) waits at least ~45ms |
| SP-1 | single page with cursor=null — yields one page then exits |
| SP-2 | multi-page — yields three pages in order |
| SP-3 | empty page is NOT yielded but cursor IS followed — skips empty first page |
| SP-4 | onPage callback runs once per page advance (including empty pages) |
| SP-5 | explicit pageSize is forwarded as limit to scan.go |

## Source-Scan Invariant Verification

`pnpm vitest run tests/unit/lock/source-scan.test.ts` passed (3/3 tests).

- `grep -n "setInterval" src/runner/sleep.ts` — no match (correct: sleep uses setTimeout)
- `grep -n "setInterval|migrationState.get(" src/runner/scan-pipeline.ts` — no match

Both new files in `src/runner/` inherit the widened source-scan glob from Plan 04-01 Task 3 automatically.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — both modules are fully functional primitives with no placeholder values.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes. The cross-entity bleed threat (T-04-07-01) is mitigated by ElectroDB's identity-stamp filter (Assumption A4 confirmed by Wave 0 spike).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| src/runner/sleep.ts | FOUND |
| src/runner/scan-pipeline.ts | FOUND |
| tests/unit/runner/sleep.test.ts | FOUND |
| tests/unit/runner/scan-pipeline.test.ts | FOUND |
| Commit c65122a (Task 1) | FOUND |
| Commit 5a4cb9b (Task 2) | FOUND |
| pnpm tsc --noEmit | PASSED |
| 7/7 unit tests | PASSED |
| source-scan.test.ts (3/3) | PASSED |
