---
phase: 06
plan: 03
subsystem: ctx
tags:
  - ctx
  - build-ctx
  - apply-flow
  - phase-06
  - wave-2
dependency_graph:
  requires:
    - src/ctx/types.ts (Plan 06-02 — MigrationCtx + ReadOnlyEntityFacade<E>)
    - src/ctx/read-only-facade.ts (Plan 06-02 — createReadOnlyFacade)
    - src/safety/fingerprint-projection.ts (Phase 1 — fingerprintEntityModel)
    - src/snapshot/read.ts (Phase 1 — readEntitySnapshot + EDBSnapshotMalformedError)
    - src/snapshot/paths.ts (Phase 1 — entitySnapshotPath)
    - src/errors/classes.ts (Phase 1 — EDBSelfReadInMigrationError + EDBStaleEntityReadError)
    - tests/unit/ctx/build-ctx.test.ts (Plan 06-01 RED tests — flipped to GREEN)
    - tests/unit/ctx/_helpers.ts (Plan 06-01 shared helpers — writeTestSnapshot used)
  provides:
    - src/ctx/build-ctx.ts (buildCtx factory)
    - src/ctx/index.ts (public barrel for ctx module)
    - src/index.ts (append-only MigrationCtx + ReadOnlyEntityFacade type re-exports)
  affects:
    - src/runner/apply-flow.ts (buildCtx wired; cwd added; ctx?: MigrationCtx typed)
    - src/runner/apply-batch.ts (cwd + ctx?: MigrationCtx added; cwd threaded through)
    - src/client/create-migrations-client.ts (cwd threaded to applyBatch)
    - Plan 06-04 (rollback orchestrator — will add ctx injection to down() path)
    - Plan 06-06 (integration tests — consume buildCtx via applyFlow with real snapshots)
    - Plan 06-08 (Phase 8 test harness — MigrationCtx + ReadOnlyEntityFacade now public)
tech_stack:
  added: []
  patterns:
    - Eager pre-flight for declared reads (CTX-05) before first v2 write (OQ4 safety property)
    - Lazy fingerprint validation + in-memory cache for undeclared targets (per-run, no re-reads)
    - Phase 8 affordance: args.ctx ?? buildCtx(...) allows test harness to inject fake ctx
    - Pitfall 3 wrap: EDBSnapshotMalformedError re-thrown with baseline remediation message
    - Circular-import avoidance: Migration.up keeps ctx?: unknown; MigrationCtx enforced at runner call site only
    - File-deletion cache probe: ESM readFileSync non-configurable — cache test uses delete+call pattern
key_files:
  created:
    - src/ctx/build-ctx.ts
    - src/ctx/index.ts
  modified:
    - src/index.ts (append-only type re-exports)
    - src/runner/apply-flow.ts (buildCtx wired + cwd + ctx typed)
    - src/runner/apply-batch.ts (cwd + ctx typed + thread-through)
    - src/client/create-migrations-client.ts (cwd threaded to applyBatch)
    - tests/unit/ctx/build-ctx.test.ts (RED → GREEN; cache spy approach updated)
decisions:
  - "src/migrations/types.ts unchanged — circular import avoidance: Migration.up keeps ctx?: unknown (PATTERNS lines 369-371); MigrationCtx enforcement is at the runner call site only"
  - "Cache probe approach for ESM: vi.spyOn(fs, 'readFileSync') throws Cannot redefine property on Node 22 ESM; replaced with file-deletion + second-call approach (if cached, no throw)"
  - "ApplyBatchArgs.ctx changed from unknown to MigrationCtx to satisfy exactOptionalPropertyTypes — aligns with ApplyFlowArgs.ctx and is an internal type (no public API break)"
  - "Phase 8 affordance preserved: args.ctx ?? await buildCtx(...) in applyFlowScanWrite; production callers never set ctx, test harness can inject fake ctx without snapshot files"
  - "Rollback wiring deferred to Plan 06-04: rollback call site in create-migrations-client.ts not modified"
metrics:
  duration_minutes: 15
  tasks_completed: 2
  files_created: 2
  files_modified: 5
  completed_date: "2026-05-09"
---

# Phase 06 Plan 03: buildCtx Factory + Apply-Flow Wiring Summary

**One-liner:** buildCtx factory with eager declared-reads pre-flight + lazy undeclared validation + in-memory cache; wired into applyFlowScanWrite between _migrations row PUT and scan loop; cwd plumbed through apply-batch and client.apply.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Implement buildCtx + ctx barrel + public type re-exports | b418b1d | src/ctx/build-ctx.ts, src/ctx/index.ts, src/index.ts, tests/unit/ctx/build-ctx.test.ts |
| 2 | Wire buildCtx into apply-flow + apply-batch + client.apply | 149cadf | src/runner/apply-flow.ts, src/runner/apply-batch.ts, src/client/create-migrations-client.ts |

## File Delta

7 files changed (plan target: 2 new + 5 modified):
- 2 files created: `src/ctx/build-ctx.ts`, `src/ctx/index.ts`
- 5 files modified: `src/index.ts`, `src/runner/apply-flow.ts`, `src/runner/apply-batch.ts`, `src/client/create-migrations-client.ts`, `tests/unit/ctx/build-ctx.test.ts`

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm tsc --noEmit` | PASS |
| `pnpm vitest run tests/unit/ctx/` (22/22) | PASS — all RED tests GREEN |
| `pnpm vitest run tests/unit/runner/` (Phase 4 regression) | PASS |
| `pnpm vitest run tests/unit/lock/source-scan.test.ts` | PASS |
| `pnpm vitest run tests/unit/` full suite | PASS (981/983 — 2 pre-existing RED: preconditions-ctx08 is Plan 06-05 scope) |
| `src/ctx/build-ctx.ts` has no `setClient(` | PASS — source-scan invariant green |
| `src/migrations/types.ts` unchanged | PASS — no circular import |
| `buildCtx` call after _migrations PUT and before scan loop | PASS — lines 149/157/164 |

## CTX Coverage

| Requirement | Status | Evidence |
|-------------|--------|---------|
| CTX-01: ctx.entity() method exists | UNIT GREEN | `typeof ctx.entity === 'function'` test passes |
| CTX-04: self-read (declared) throws at buildCtx time | UNIT GREEN | EDBSelfReadInMigrationError at eager pre-flight |
| CTX-04: self-read (undeclared/runtime) throws at entity() call | UNIT GREEN | EDBSelfReadInMigrationError in entity() method body |
| CTX-05: declared reads eager pre-flight mismatch | UNIT GREEN | EDBStaleEntityReadError before scan loop |
| CTX-05: declared reads eager pre-flight match | UNIT GREEN | buildCtx resolves; facade available |
| CTX-05: lazy validation (undeclared) mismatch | UNIT GREEN | EDBStaleEntityReadError at entity() call time |
| CTX-05: lazy cache — no re-read on second entity() | UNIT GREEN | file-delete probe: second call succeeds even with deleted snapshot |
| CTX-06: reads persistence in _migrations row | EXISTING (Phase 4) | apply-flow.ts:132 already persists reads; this plan threads typed ctx so Plan 06-06 can confirm the audit row |

## Architecture: buildCtx Call Ordering (T-06-03-01)

```
applyFlowScanWrite
  │
  ├── _migrations.put({ status: 'pending', ...reads }).go()    ← line 149 (PUT FIRST)
  │
  ├── const ctx = args.ctx ?? await buildCtx(...)              ← line 157 (THEN buildCtx)
  │     ├── Eager pre-flight: declared reads fingerprint check
  │     └── Returns MigrationCtx with lazy-validation entity() method
  │
  └── for await (const page of iterateV1Records(...))          ← line 164 (THEN scan)
        └── v2 = await migration.up(v1, ctx)
```

This ordering is the load-bearing safety invariant: stale-read errors surface BEFORE any v2 write, and the audit row exists BEFORE buildCtx throws (so applyFlow's catch block can patch status='failed').

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ESM readFileSync non-configurable on Node 22**
- **Found during:** Task 1 — build-ctx.test.ts cache test
- **Issue:** The RED test scaffolded in Plan 06-01 used `vi.spyOn(fs, 'readFileSync')` to verify the cache. On Node 22 ESM, `readFileSync` is a non-configurable property of the `node:fs` module — `vi.spyOn` throws `Cannot redefine property: readFileSync`.
- **Fix:** Replaced the spy-based approach with a file-deletion probe: write snapshot, call `ctx.entity(Team)` to prime the cache, delete the snapshot file, call `ctx.entity(Team)` again — if cached, the second call does NOT throw (it doesn't read the disk); if not cached, it throws `EDBSnapshotMalformedError`. This tests the same behavior with a different mechanism.
- **Files modified:** `tests/unit/ctx/build-ctx.test.ts`
- **Commit:** b418b1d

**2. [Rule 1 - Bug] ApplyBatchArgs.ctx typed as `unknown` incompatible with ApplyFlowArgs.ctx: MigrationCtx**
- **Found during:** Task 2 — TypeScript compile error after changing ApplyFlowArgs.ctx to MigrationCtx
- **Issue:** `exactOptionalPropertyTypes: true` is set in tsconfig; spreading `ctx?: unknown` from ApplyBatchArgs into ApplyFlowArgs where `ctx?: MigrationCtx` is expected produces `Type 'null' is not assignable to type 'MigrationCtx'`.
- **Fix:** Updated `ApplyBatchArgs.ctx` type from `unknown` to `MigrationCtx`. `ApplyBatchArgs` is an internal type (not part of the public API surface) so this is not a breaking change. Added import for `MigrationCtx` from `'../ctx/index.js'`.
- **Files modified:** `src/runner/apply-batch.ts`
- **Commit:** 149cadf

## Known Stubs

None. All new files are fully functional — no placeholder values, hardcoded empty returns, or unwired data sources.

## Threat Surface Scan

No new network endpoints or auth paths. `src/ctx/build-ctx.ts` reads from the local filesystem via `entitySnapshotPath` + `readEntitySnapshot` — this is the same path traversal validation already in `src/snapshot/paths.ts:47-52` (entity name cannot contain `/`, `\\`, or `..`). No new threat flags.

## Threat Model Mitigations Applied

| Threat ID | Mitigation Applied |
|-----------|--------------------|
| T-06-03-01 | buildCtx call is between `_migrations.put(...).go()` (line 149) and `for await (iterateV1Records...)` (line 164). Ordering verified via `grep -n "buildCtx\|.go();\|iterateV1Records"`. |
| T-06-03-02 | `args.ctx ?? await buildCtx(...)` — Phase 8 test harness affordance intentional; production callers never set args.ctx. |
| T-06-03-03 | Snapshot path included in remediation message for operator discoverability — own filesystem, no third-party data. |
| T-06-03-04 | Wrong cwd → EDBSnapshotMalformedError wrapped with "run baseline" remediation surfaced at eager pre-flight before any v2 write. |
| T-06-03-05 | In-memory cache prevents mid-run snapshot-file changes from affecting validation. |

## Self-Check: PASSED

Files verified:
- src/ctx/build-ctx.ts: FOUND
- src/ctx/index.ts: FOUND
- src/index.ts (MigrationCtx + ReadOnlyEntityFacade exports): FOUND
- src/runner/apply-flow.ts (buildCtx import + call): FOUND
- src/runner/apply-batch.ts (cwd + MigrationCtx): FOUND
- src/client/create-migrations-client.ts (cwd in applyBatch call): FOUND
- tests/unit/ctx/build-ctx.test.ts (RED → GREEN): FOUND

Commits verified:
- b418b1d (Task 1)
- 149cadf (Task 2)
