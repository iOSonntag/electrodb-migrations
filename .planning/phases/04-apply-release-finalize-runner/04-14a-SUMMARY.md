---
plan: 04-14a
status: complete
title: 1k apply happy path + multi-migration batch + guarded-write-at-boundary integration tests
key_files:
  created:
    - tests/integration/runner/apply-happy-path-1k.test.ts
    - tests/integration/runner/apply-batch.test.ts
    - tests/integration/runner/guarded-write-at-boundary.test.ts
  modified:
    - src/guard/wrap.ts
    - src/guard/index.ts
    - src/client/create-migrations-client.ts
    - src/cli/commands/apply.ts
    - src/runner/apply-flow.ts
    - tests/unit/cli/commands/apply.test.ts
    - tests/unit/client/create-migrations-client.test.ts
    - tests/unit/runner/apply-flow.test.ts
commits:
  - bad47cf "feat(04-14a): Task 1 — 1k happy path + B-01 SC1 + W-02 RUN-09 + T-04-11-03 fixes"
  - c8db5be "feat(04-14a): Task 2 — RUN-05 multi-migration batch end-to-end (apply-batch.test.ts)"
  - 97a8cc7 "feat(04-14a): Task 3 — B-02 guarded write at multi-migration boundary (Decision A7 end-to-end)"
  - 11d0ce4 "chore: merge executor worktree (worktree-agent-ac7ad89dd5583dff1 — plan 04-14a)"
  - ad58d86 "fix(04-14a): guarded-write-at-boundary outcome type — exactOptionalPropertyTypes"
note: |
  This SUMMARY.md was reconstructed by the orchestrator after the executor's worktree was
  force-removed before its SUMMARY commit landed. Content reflects the post-merge state, not
  the executor's original SUMMARY draft.
---

# 04-14a — 1k Apply Happy Path + Multi-Migration Batch + Guarded-Write Integration Tests

## What landed

Three integration tests proving Phase 4 success criteria:

1. **`apply-happy-path-1k.test.ts`** — proves SC #1: 1,000-record apply against DDB Local, all v1 records transformed to v2, status row marked `applied`.
2. **`apply-batch.test.ts`** — RUN-05 multi-migration batch end-to-end (apply chain across 2 migrations, lock held continuously across the boundary).
3. **`guarded-write-at-boundary.test.ts`** — Decision A7 end-to-end: guarded app writes are gated during apply, succeed during release, gated again during the next apply.

## Source-code changes (Rule-1/3 deviations)

These code edits landed alongside the integration tests to make them pass:

- **`src/guard/wrap.ts`** + **`src/guard/index.ts`** — added `runUnguarded` export. Used by `create-migrations-client.ts` to bypass the guard middleware during the runner's own scan/write loop (T-04-11-03 fix — runner reads/writes were being gated by its own lock, infinite recursion).
- **`src/client/create-migrations-client.ts`** — runner code paths now wrap their work in `runUnguarded(...)`. Added RUN-09 apply summary write to stderr after `applyBatch` completes.
- **`src/cli/commands/apply.ts`** — removed the duplicate summary write (the client now owns it).
- **`src/runner/apply-flow.ts`** — `applyFlowScanWrite` now upserts the `_migrations` row at the start of the scan loop so the post-loop `transitionToReleaseMode` `patch()` doesn't fail with `ConditionalCheckFailed` (`patch()` adds an implicit `attribute_exists(pk)` condition).

## Test outcomes

- 3 integration tests passing under DDB Local
- All unit tests still green after Rule-1 source edits
- `tsc --noEmit` exit 0
