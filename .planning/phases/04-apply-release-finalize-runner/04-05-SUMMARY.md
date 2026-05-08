---
phase: "04-apply-release-finalize-runner"
plan: "05"
subsystem: "runner"
tags:
  - runner
  - safety
  - tdd
  - phase-04
  - wave-1
dependency_graph:
  requires:
    - "src/safety/batch-write-retry.ts (withBatchWriteRetry)"
    - "@aws-sdk/lib-dynamodb BatchWriteCommand"
    - "src/migrations/types.ts (Migration, AnyElectroEntity)"
  provides:
    - "src/runner/batch-flush.ts (batchFlushV2, BatchFlushArgs)"
    - "tests/unit/runner/_stub-service.ts (makeRunnerStubService)"
  affects:
    - "apply-flow.ts — will call batchFlushV2 per scanned page"
    - "count-audit.ts — consumes BatchWriteRetryResult.written"
tech_stack:
  added:
    - "src/runner/ directory (new)"
    - "tests/unit/runner/ directory (new)"
  patterns:
    - "marshal-before-send (RUN-08 fail-fast)"
    - "25-record chunk slicing (DDB BatchWriteItem limit)"
    - "withBatchWriteRetry composition (Pitfall #4 defense)"
key_files:
  created:
    - "src/runner/batch-flush.ts"
    - "tests/unit/runner/batch-flush.test.ts"
    - "tests/unit/runner/_stub-service.ts"
  modified: []
decisions:
  - "BF-6 assertion: check error.code property rather than message text (EDBBatchWriteExhaustedError carries code='EDB_BATCH_WRITE_EXHAUSTED')"
  - "PutEntity type alias (single) replaces two-type ElectroDbPutChain+ElectroDbEntity pattern for concision"
  - "Stub service params() returns record verbatim — unit tests verify RequestItems shape without real ElectroDB"
metrics:
  duration_minutes: 30
  completed_date: "2026-05-08"
  tasks_completed: 1
  files_created: 3
  tests: 8
---

# Phase 4 Plan 05: batchFlushV2 Marshal+Retry Adapter Summary

**One-liner:** `batchFlushV2` adapter that marshals v2 records via ElectroDB `put().params()` for schema validation then ships under `withBatchWriteRetry` with 25-item chunk slicing (RUN-03).

## What Was Built

### `src/runner/batch-flush.ts` (71 lines)

The Phase 1 JSDoc seam ("Phase 4 wires this to a real BatchWriteCommand") is now fulfilled.

Key design decisions:
- **Marshal-all-before-send**: The entire `records` array is marshalled via `migration.to.put(record).params()` before the first `client.send`. A schema-validation throw on any record aborts without shipping earlier records (RUN-08 fail-fast; BF-5 verifies).
- **25-record chunk slicing**: `DDB_BATCH_LIMIT = 25` enforces the DDB BatchWriteItem hard limit. Each chunk gets its own `withBatchWriteRetry` instance so the retry budget resets per chunk.
- **Retry delegation**: `withBatchWriteRetry` from `src/safety/index.ts` handles `UnprocessedItems` retry with full-jitter exponential backoff. Exhaustion throws `EDBBatchWriteExhaustedError` (no silent success — Pitfall #4 defense; BF-6 verifies).
- **Audit triple passthrough**: Returns the SUMMED `BatchWriteRetryResult` so apply-flow can call `count-audit.addMigrated(result.written)` directly.
- **Zero new dependencies**: uses existing `@aws-sdk/lib-dynamodb` (transitive) and `src/safety/index.js`.

### `tests/unit/runner/_stub-service.ts`

Minimal runner unit-test stub providing:
- `makeRunnerStubService()` factory
- `batchWriteSendSpy` vi.fn() — default returns `{UnprocessedItems: undefined}` (all written)
- `makeMigration()` — returns a Migration-shaped stub where `to.put(record).params()` returns the record verbatim
- `setScanPages()` — for future scan-pipeline tests

### `tests/unit/runner/batch-flush.test.ts`

8 test cases covering the full behavioral contract:

| ID   | Test Name                                               | Assertion |
|------|---------------------------------------------------------|-----------|
| BF-1 | empty input returns {0,0,0} without calling send        | `scanned=written=unprocessed=0`, `send` not called |
| BF-2 | single batch (5 records) — all written in one send call | `scanned=5, written=5`, `send` called once, `RequestItems[tableName]` has 5 items |
| BF-3 | multi-batch (50 records → 2 calls of 25 each)           | `send` called twice, each with 25 items |
| BF-4 | UnprocessedItems retry → onRetry called once            | `result={5,5,0}`, `onRetry` called with `{attempt:1, remaining:1}` |
| BF-5 | validation throw → send not called (RUN-08 fail-fast)   | `throws 'schema validation'`, `send` not called |
| BF-6 | retry exhaustion → EDBBatchWriteExhaustedError code     | `err.code === 'EDB_BATCH_WRITE_EXHAUSTED'` |
| BF-7 | RequestItems shape deep equality for 25 records         | `{PutRequest: {Item: record}}` for each item verbatim |
| BF-8 | empty input — no marshal calls, no send calls           | `put` spy NOT called, `send` NOT called |

## TDD Gate Compliance

- RED commit: `ea46ef3` — `test(04-05): RED — batchFlushV2 marshal+retry shape (RUN-03)` (module-not-found failure confirmed)
- GREEN commit: `5e0bd3d` — `feat(04-05): GREEN — batchFlushV2 marshal+retry adapter (RUN-03)` (8/8 passing)
- REFACTOR commit: `fda5f04` — `refactor(04-05): slim batch-flush.ts to ≤80 lines — consolidate types, shorten doc` (tests remain green)

## Deviations from Plan

### Auto-added Missing Critical Functionality

**1. [Rule 2 - Missing Prerequisite] Created runner stub service (plan 04-01 Task 2)**
- **Found during:** Task start — `tests/unit/runner/_stub-service.ts` referenced by plan but plan 04-01 has not been executed
- **Fix:** Created minimal `makeRunnerStubService()` with `batchWriteSendSpy`, `makeMigration()` factory, and `setScanPages()` stub
- **Files modified:** `tests/unit/runner/_stub-service.ts` (new)
- **Commit:** `ea46ef3`

**2. [Rule 1 - Bug] BF-6 test assertion corrected**
- **Found during:** First GREEN run — test used `.rejects.toThrow('EDB_BATCH_WRITE_EXHAUSTED')` which checks the message string, but `EDBBatchWriteExhaustedError` message says "BatchWriteItem retry exhausted after N attempts..."
- **Fix:** Changed to `.catch((e) => e)` then assert `err.code === 'EDB_BATCH_WRITE_EXHAUSTED'` (the `code` property is on the error class, not the message)
- **Files modified:** `tests/unit/runner/batch-flush.test.ts`
- **Commit:** `5e0bd3d`

## Verification Results

- `pnpm vitest run tests/unit/runner/batch-flush.test.ts` — 8/8 tests green
- `grep -n "withBatchWriteRetry\|BatchWriteCommand" src/runner/batch-flush.ts` — 2+ matches confirmed
- `grep -n "batchFlushV2" src/index.ts` — NO match (internal-only, not exported)
- `wc -l src/runner/batch-flush.ts` — 71 lines (≤80 success criterion met)
- `DDB_BATCH_LIMIT = 25` constant confirmed in source

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. `batchFlushV2` is internal-only (not exported from `src/index.ts`). The threat mitigations from plan's STRIDE register are all covered:

| Threat | Mitigation | Verified by |
|--------|-----------|-------------|
| T-04-05-01 UnprocessedItems silent drop | `withBatchWriteRetry` + BF-4/BF-6 | BF-4, BF-6 |
| T-04-05-02 Schema-invalid v2 record | marshal-before-send | BF-5 |
| T-04-05-03 Unbounded retry DoS | `maxAttempts: 5` default in Phase 1 | BF-6 |
| T-04-05-04 PII in error | count-only in error details | accepted |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/runner/batch-flush.ts` exists | FOUND |
| `tests/unit/runner/batch-flush.test.ts` exists | FOUND |
| `tests/unit/runner/_stub-service.ts` exists | FOUND |
| RED commit `ea46ef3` exists | FOUND |
| GREEN commit `5e0bd3d` exists | FOUND |
| REFACTOR commit `fda5f04` exists | FOUND |
