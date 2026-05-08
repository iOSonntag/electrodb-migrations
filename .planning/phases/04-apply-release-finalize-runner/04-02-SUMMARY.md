---
phase: 04-apply-release-finalize-runner
plan: "02"
subsystem: runner
tags:
  - runner
  - count-audit
  - phase-04
  - wave-1
  - tdd
dependency_graph:
  requires:
    - "src/internal-entities/migrations.ts (itemCounts shape)"
    - "src/safety/batch-write-retry.ts (BatchWriteRetryResult shape reference)"
  provides:
    - "src/runner/count-audit.ts — ItemCounts type + createCountAudit factory"
  affects:
    - "src/runner/apply-flow.ts (future — will call addMigrated, assertInvariant)"
    - "src/runner/finalize-flow.ts (future — will call assertInvariant before status write)"
tech_stack:
  added: []
  patterns:
    - "Zero-dependency closure accumulator (no imports, pure TS)"
    - "Object.freeze() for snapshot independence"
    - "Discriminated error messages with invariant triple + requirement ID"
key_files:
  created:
    - path: "src/runner/count-audit.ts"
      description: "ItemCounts type + createCountAudit factory with assertInvariant — 43 lines including JSDoc"
    - path: "tests/unit/runner/count-audit.test.ts"
      description: "8 TDD cases covering the RED→GREEN cycle for RUN-04 invariant"
  modified: []
decisions:
  - "addMigrated(-1) throws via generic Error (not a custom class) — internal invariant; custom class is overkill for a pure-data module"
  - "OQ-1 pinned: scanned = records pulled off v1 cursor up to moment of decision"
  - "OQ-2 pinned: up() returning null/undefined counts as skipped (not failed)"
metrics:
  duration: "~10 minutes"
  completed_date: "2026-05-08"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase 04 Plan 02: Count-Audit Accumulator (RUN-04) Summary

**One-liner:** Zero-dependency closure accumulator enforcing `scanned == migrated + skipped + failed` with `Object.freeze()` snapshot isolation and `RUN-04`-tagged error messages.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| RED | Write 8 failing test cases for count-audit invariant | b305401 | tests/unit/runner/count-audit.test.ts |
| GREEN | Implement createCountAudit factory with assertInvariant | 8ea39b7 | src/runner/count-audit.ts |

## TDD Gate Compliance

- RED gate: `test(04-02): RED — count-audit invariant cases (RUN-04)` — commit b305401
- GREEN gate: `feat(04-02): GREEN — count-audit accumulator (RUN-04)` — commit 8ea39b7
- REFACTOR gate: Not needed — module is 43 lines, self-explanatory, no cleanup required

## Test Names (8 cases)

1. `fresh accumulator returns all-zero snapshot`
2. `increment paths each step their counter by 1; addMigrated(n) adds n; addMigrated(0) is a no-op`
3. `assertInvariant does NOT throw on success path (scanned == migrated + skipped)`
4. `assertInvariant does NOT throw on fail-fast path (scanned == migrated + skipped + 1)`
5. `assertInvariant throws on over-count with exact triple and RUN-04 in message`
6. `assertInvariant throws on under-count (9 != 10)`
7. `snapshot is independent: subsequent increments do NOT mutate the snapshot`
8. `addMigrated rejects negative values`

## Verification Results

- `pnpm vitest run tests/unit/runner/count-audit.test.ts` — 8 passing, 0 failing
- `tsc --noEmit` — exits 0, no type errors
- `grep -n "RUN-04" src/runner/count-audit.ts` — 3 hits (JSDoc + addMigrated error + assertInvariant error)
- Module has zero `import` statements — pure data module, no runtime dependencies
- File length: 43 lines (within ≤45 line success criterion)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| `addMigrated(-1)` throws via generic `Error` | Internal invariant; a custom subclass would be overkill for a pure-data module with a single in-process caller. The message includes `RUN-04` to identify the requirement. |
| OQ-1: `scanned` = records pulled off v1 cursor up to decision | Simpler than pre-flight COUNT; consistent on success and fail-fast paths; matches RESEARCH recommendation |
| OQ-2: `up()` returning null/undefined = `skipped` | Gives the audit triple a meaningful third slot; documented in JSDoc; future apply-flow.ts will enforce this |
| `Object.freeze()` on snapshot | Prevents accidental mutation; snapshot independence is a load-bearing property for audit auditability (T-04-02-02) |

## Deviations from Plan

None — plan executed exactly as written.

The accidental early commit to the main repo's `main` branch during execution was immediately reversed with `git reset --hard HEAD~1` before the correct commit was made to the worktree branch.

## Known Stubs

None — this is a pure accumulator module. No data flows to UI rendering; no placeholders.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. The module is in-process only.

## Self-Check: PASSED

- `src/runner/count-audit.ts` — FOUND
- `tests/unit/runner/count-audit.test.ts` — FOUND
- Commit b305401 (RED) — FOUND
- Commit 8ea39b7 (GREEN) — FOUND
