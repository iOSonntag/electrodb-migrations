---
phase: 03-internal-entities-lock-guard
plan: 04
subsystem: lock
tags: [lock, electrodb, dynamodb, heartbeat, consistent-read, source-scan, lck-01, lck-02, lck-03, lck-07, lck-08, lck-10, pitfall-1, pitfall-2]
requires:
  - phase: 03-internal-entities-lock-guard
    plan: 03-02
    provides: MigrationsServiceBundle, MIGRATION_STATE_ID, lockState 'dying' enum
  - phase: 03-internal-entities-lock-guard
    plan: 03-03
    provides: state-mutations.acquire / heartbeat / markFailed / unlock + AcquireArgs / UnlockResult types
  - phase: 01-foundation-safety-primitives
    provides: CONSISTENT_READ named constant, startHeartbeatScheduler primitive, EDBMigrationLockHeldError
provides:
  - lock-orchestrator-module
  - acquireLock (LCK-01: state-mutations.acquire + read-back-verify)
  - startLockHeartbeat (LCK-02 / LCK-10: thin wrapper over Phase 1 scheduler)
  - forceUnlock (LCK-08: thin orchestrator over state-mutations.unlock)
  - readLockRow (LCK-07: canonical strongly-consistent reader for src/lock and src/guard)
  - staleCutoffIso (single source of truth for stale-cutoff math)
  - LockRowSnapshot type (used by Plan 05's guard cache)
  - source-scan invariants for src/lock/ (LCK-07 + Pitfall #2)
affects:
  - 03-05 guard (will import readLockRow for the guard's cache fetchLockState callback)
  - 03-06 lock-integration-tests (uses acquireLock + forceUnlock directly)
  - 04 runner (calls acquireLock + startLockHeartbeat in the apply loop; honors LCK-04 acquireWaitMs sleep documented in acquireLock JSDoc)
  - 05 rollback / finalize CLI commands (use forceUnlock through Phase 5 admin commands)
tech-stack:
  added: []
  patterns:
    - "Thin orchestrator pattern: src/lock/ wrappers add zero direct DDB writes — every write is delegated to a state-mutations verb"
    - "Single-reader chokepoint: every src/lock/ and src/guard/ read of _migration_state goes through readLockRow"
    - "Source-scan invariants enforce naming over rendering: code review greps for `consistent: CONSISTENT_READ` (the named import), not just `consistent: true`"
    - "LCK-04 acquireWaitMs is documented as the runner's responsibility; orchestrators do NOT silently sleep"
key-files:
  created:
    - src/lock/stale-cutoff.ts
    - src/lock/read-lock-row.ts
    - src/lock/acquire.ts
    - src/lock/unlock.ts
    - src/lock/heartbeat.ts
    - src/lock/index.ts
    - tests/unit/lock/stale-cutoff.test.ts
    - tests/unit/lock/read-lock-row.test.ts
    - tests/unit/lock/heartbeat.test.ts
    - tests/unit/lock/source-scan.test.ts
  modified: []
  deleted: []
decisions:
  - "ElectroDB v3.7.5 strongly-consistent read option name verified as `consistent: boolean` (index.d.ts:2653); CONSISTENT_READ is the named-import literal `true` and matches the type"
  - "src/lock/heartbeat.ts is 36 lines including JSDoc — under the ≤40 cap; deviates from the plan's verbatim 25-line sketch only by carrying enough JSDoc to make the Pitfall #2 contract obvious to future readers"
  - "Task 1 ↔ Task 2 ordering: Task 1's barrel (src/lock/index.ts) was deferred from re-exporting startLockHeartbeat/StartLockHeartbeatArgs until Task 2 created heartbeat.ts; this preserves TDD purity for Task 2 instead of forcing Task 1 to ship an empty heartbeat stub"
  - "vi.spyOn typing: the mixed type/value re-exports in src/safety/index.ts and src/state-mutations/index.ts confuse vi.spyOn's second-generic constraint; the heartbeat test uses inferred typing + a `mockImplementation(... as never)` cast — runtime behavior identical, the strict typing is sacrificed in the test layer only"
metrics:
  tasks_completed: 2
  tasks_total: 2
  unit_tests_added: 16
  unit_tests_total: 542
  files_changed: 10
  lines_added: 448
  lines_removed: 13
  duration_minutes: 11
  completed: "2026-05-08"
---

# Phase 3 Plan 04: Lock Orchestrators Summary

**One-liner:** Five thin orchestrators in `src/lock/` over Phase 1's safety primitives and Plan 03's state-mutations verbs — `acquireLock` (state-mutations.acquire + read-back verify), `startLockHeartbeat` (≤40-line wrapper over `startHeartbeatScheduler`), `forceUnlock` (passthrough to state-mutations.unlock), and the chokepoint helpers `readLockRow` / `staleCutoffIso` — gated by source-scan invariants that fail the build on Pitfall #1 (eventually-consistent reads) or Pitfall #2 (`setInterval` re-introduction).

## What Was Done

### The four orchestrators + two helpers

| Symbol | File | Role | Calls |
|--------|------|------|-------|
| `acquireLock` | `src/lock/acquire.ts` | Acquire + read-back verify (LCK-01) | `state-mutations.acquire` → `readLockRow` |
| `startLockHeartbeat` | `src/lock/heartbeat.ts` | Heartbeat wrapper (LCK-02 / LCK-10) | `startHeartbeatScheduler` (work=`state-mutations.heartbeat`, onAbort=`state-mutations.markFailed`) |
| `forceUnlock` | `src/lock/unlock.ts` | Operator escape hatch (LCK-08) | `state-mutations.unlock` (passthrough) |
| `readLockRow` | `src/lock/read-lock-row.ts` | Sole strongly-consistent reader for `_migration_state` (LCK-07) | `migrationState.get(...).go({ consistent: CONSISTENT_READ })` |
| `staleCutoffIso` | `src/lock/stale-cutoff.ts` | Pure helper for stale-cutoff math | (none — pure) |
| `index.ts` | barrel | Named-only exports | — |

#### `acquireLock` (LCK-01 — the highest-stakes function in the lock subsystem)

```ts
export async function acquireLock(service: MigrationsServiceBundle, config: ResolvedConfig, args: AcquireArgs): Promise<void>
```

Two-step algorithm verbatim from RESEARCH.md Pattern 1:

1. Call `state-mutations.acquire(service, config, args)`. The verb issues the 2-item transactWrite (`_migration_state` patch + `_migration_runs` put) with the LCK-01 + LCK-03 ConditionExpression. On `ConditionalCheckFailed` the verb itself throws `EDBMigrationLockHeldError` carrying the current-holder details (Plan 03's work).
2. Read-back verify via `readLockRow`. If the row is missing OR `lockRunId !== args.runId`, throw `EDBMigrationLockHeldError`. Defends torn reads.

LCK-04 (`acquireWaitMs` sleep) is **not** issued by this function. Phase 4's runner is responsible for `await sleep(config.lock.acquireWaitMs)` AFTER `acquireLock` returns. The seam is documented in JSDoc as T-03-23 disposition.

#### `startLockHeartbeat` (LCK-02 / LCK-10 — Pitfall #2 mitigation)

```ts
export function startLockHeartbeat(args: StartLockHeartbeatArgs): HeartbeatScheduler
```

36-line file (under the ≤40 cap). The body is a single `startHeartbeatScheduler({...})` call:
- `intervalMs: args.config.lock.heartbeatMs`
- `work: () => heartbeatMutation(args.service, { runId: args.runId })`
- `onAbort: (err) => void markFailed(args.service, { runId, migId?, cause: err })`
- `maxConsecutiveFailures` is **NOT overridden** — Phase 1's default of 2 is exactly LCK-10.

The optional `migId` is forwarded to `markFailed` only when present, using a guarded spread (`...(args.migId !== undefined ? { migId: args.migId } : {})`) so the verb's `migId?` parameter stays under TypeScript's `exactOptionalPropertyTypes: true`.

#### `forceUnlock` (LCK-08 — thin orchestrator)

```ts
export async function forceUnlock(service: MigrationsServiceBundle, args: { runId: string }): Promise<UnlockResult>
```

Passthrough to `state-mutations.unlock`. The verb already performs the LCK-08 truth-table dispatch (read with `consistent: CONSISTENT_READ`, then `markFailed` for active states, forced clear for `release`/`failed`, no-op for `free`). Keeping the dispatch in exactly one place (the verb, not the orchestrator) prevents documentation drift.

#### `readLockRow` (LCK-07 — the chokepoint)

```ts
export async function readLockRow(service: MigrationsServiceBundle): Promise<LockRowSnapshot | null>
```

The ONLY place `src/lock/` and `src/guard/` (Plan 05) read the `_migration_state` row. Calls `migrationState.get({ id: 'state' }).go({ consistent: CONSISTENT_READ })`. Returns `null` when ElectroDB returns no data. The `LockRowSnapshot` interface declares `inFlightIds`/`failedIds`/`releaseIds` as `ReadonlySet<string>` so callers cannot mutate the captured shape.

ElectroDB option name verification: `electrodb@3.7.5/index.d.ts:2653` declares `consistent?: boolean` on the single-item `.go()` options. The `CONSISTENT_READ` constant is `true as const` — direct match.

#### `staleCutoffIso` (pure helper)

```ts
export function staleCutoffIso(config: ResolvedConfig): string
```

Returns `new Date(Date.now() - config.lock.staleThresholdMs).toISOString()`. Pure; deterministic given a frozen clock. Not currently consumed by `state-mutations/acquire.ts` (which inlines the same math) — it exists for future consumers (e.g. Phase 4's `status` command displaying "X minutes until takeover").

### Source-scan invariants (the load-bearing guardrails)

Three invariants in `tests/unit/lock/source-scan.test.ts` (all GREEN against the lock subsystem; they fail the build only on future regressions):

1. **LCK-07 — every `migrationState.get(` call under `src/lock/` uses `consistent: CONSISTENT_READ`.** Implementation widens the per-line scan to a 3-line window so multi-line `.get(...).go({ consistent: ... })` chains are correctly attributed.
2. **Pitfall #2 — no `setInterval` anywhere under `src/lock/` outside comments.** Uses `stripCommentLines` from `tests/_helpers/source-scan.ts` so JSDoc that NAMES the forbidden API doesn't trip the scan.
3. **Defense-in-depth — no inline `consistent: true` under `src/lock/`.** Even if a future file opted out of importing `CONSISTENT_READ`, the inline literal would fail this scan, forcing the named import.

Plan 05 will widen these scans to also cover `src/guard/` once that directory exists.

### Tests added (16 unit tests across 4 files)

| File | Tests | Coverage |
|------|-------|----------|
| `tests/unit/lock/stale-cutoff.test.ts` | 3 | Frozen-clock determinism (4h, 60s, millisecond precision) |
| `tests/unit/lock/read-lock-row.test.ts` | 4 | `consistent: CONSISTENT_READ` passed to `.go(...)`; `id: 'state'` sentinel; `null` on missing row; verbatim row return |
| `tests/unit/lock/heartbeat.test.ts` | 6 | `intervalMs` forwarded; `maxConsecutiveFailures` NOT overridden; scheduler returned verbatim; work callback invokes `state-mutations.heartbeat`; onAbort invokes `state-mutations.markFailed` (with and without `migId`) |
| `tests/unit/lock/source-scan.test.ts` | 3 | LCK-07 ConsistentRead scan; Pitfall #2 no-setInterval scan; defense-in-depth no inline `consistent: true` |

Total suite: 542 / 542 passing; `pnpm typecheck` clean; `pnpm exec biome check ./src/lock ./tests/unit/lock` clean.

## Source-Scan Invariants (now enforced via tests)

```
pnpm vitest run tests/unit/lock/source-scan.test.ts  → 3/3 GREEN
grep -c 'CONSISTENT_READ' src/lock/read-lock-row.ts  → 4 (1 import, 1 JSDoc x2, 1 call site)
grep -c 'readLockRow' src/lock/acquire.ts            → 3 (1 import, 1 JSDoc, 1 call site)
wc -l src/lock/heartbeat.ts                          → 36 (≤40)
```

`grep -c 'setInterval' src/lock/heartbeat.ts` → 2 — both inside JSDoc comments (the file has explicit "Forbidden: `setInterval`" warnings). The `stripCommentLines`-aware source-scan test confirms zero matches outside comments.

## Decisions Made

- **ElectroDB `consistent` option verified.** `electrodb@3.7.5/index.d.ts:2653` exposes `consistent?: boolean` on single-item `.go(...)` options; the existing `state-mutations/unlock.ts` already uses this name — `readLockRow` matches.
- **Heartbeat file kept marginally above the plan's 25-line sketch (36 lines).** The plan's `<acceptance_criteria>` allows ≤40 lines including JSDoc; the extra lines are JSDoc that names the forbidden `setInterval` API and the `maxConsecutiveFailures` rationale. Source-scan strips comments before checking, so the no-`setInterval` invariant still passes.
- **Task 1 ↔ Task 2 barrel ordering.** Plan 03-04's verbatim Step 5 had Task 1's `src/lock/index.ts` re-export `startLockHeartbeat` from `./heartbeat.js`, but Task 2 is the task that creates `heartbeat.ts`. Forcing Task 1 to ship a stub heartbeat would void Task 2's TDD RED gate. Resolution: Task 1's barrel exports four of the five symbols; Task 2 re-opens the barrel to add the fifth. Captured as a Rule 3 deviation below; pattern matches Plan 03-01 deviation 3 ("Task 1 barrel referenced eventual-consistency.ts created in Task 2").
- **`vi.spyOn` typing in `heartbeat.test.ts`.** TypeScript's second-generic constraint on `vi.spyOn<T, K extends keyof T>` interacts poorly with module re-exports that mix `type` and value bindings (the `safety/index.ts` and `state-mutations/index.ts` barrels both do this). The constraint resolves to `'CONSISTENT_READ' | 'CONSISTENT_READ_MARKER' | 'EDBBatchWriteExhaustedError'` instead of including `startHeartbeatScheduler`. Workaround: drop the explicit generic, declare the spy as `ReturnType<typeof vi.fn>` plus a `vi.spyOn(safety, 'startHeartbeatScheduler').mockImplementation(spy as never)` cast. Runtime behavior is identical; the strict typing is sacrificed in the test layer only. Recorded so Plan 05's guard tests don't fall into the same trap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1's barrel cannot typecheck without `src/lock/heartbeat.ts`**

- **Found during:** Task 1, after writing the four source files and the barrel.
- **Issue:** PLAN.md Step 5 of Task 1 prescribed a 5-export barrel including `startLockHeartbeat` from `./heartbeat.js`, but Task 2 creates `heartbeat.ts`. As written the Task 1 GREEN commit's `pnpm typecheck` would fail.
- **Fix:** Shipped a 4-export barrel in Task 1 (acquireLock, forceUnlock, readLockRow + LockRowSnapshot, staleCutoffIso); Task 2 re-opened the barrel to add the heartbeat exports. Documented inline in `src/lock/index.ts` so the cross-task ordering is obvious to future readers.
- **Files modified:** `src/lock/index.ts` (Task 1, then again in Task 2).
- **Verification:** Task 1 `pnpm typecheck` exits 0; Task 2 `pnpm typecheck` exits 0; final barrel matches the plan's intended 5-export shape.
- **Commits:** `1d524d7` (Task 1 GREEN, partial barrel), `2b70bec` (Task 2 GREEN, completed barrel).

**2. [Rule 1 - Bug] `vi.spyOn<typeof safety, 'startHeartbeatScheduler'>` typecheck failure**

- **Found during:** Task 2 GREEN typecheck, after writing `heartbeat.test.ts` and `heartbeat.ts`.
- **Issue:** TypeScript reported `Type '"startHeartbeatScheduler"' does not satisfy the constraint '"EDBBatchWriteExhaustedError" | "CONSISTENT_READ" | "CONSISTENT_READ_MARKER"'`. The mixed type/value re-exports in `src/safety/index.ts` (`type HeartbeatOptions`, `type HeartbeatScheduler`, value `startHeartbeatScheduler`) confuse `vi.spyOn`'s second-generic `keyof T` constraint, which collapses to a partial subset.
- **Fix:** Dropped the explicit generic on `vi.spyOn`; declared the spy variables as `ReturnType<typeof vi.fn>`; cast the implementation to `as never` inside `mockImplementation`. The cast is in the test-only layer; runtime semantics are identical.
- **Files modified:** `tests/unit/lock/heartbeat.test.ts`.
- **Verification:** `pnpm typecheck` exits 0; all 6 heartbeat tests pass.
- **Commit:** `2b70bec`.

### Cosmetic — biome auto-format

The first draft of `src/lock/read-lock-row.ts` had `return ((res as { data: ... }).data ?? null);` with redundant outer parens. Biome's formatter rejected the parens; trivially fixed by removing them. No behavior change. Caught and fixed in the same edit pass before commit.

### Authentication Gates

None — this plan has no external-service auth surface.

## Threat Surface Scan

No new network endpoints, file-access patterns, schema changes at trust boundaries, or auth paths beyond what the plan's `<threat_model>` enumerates. The new surface is entirely within the framework's own DDB-read boundary (`readLockRow` is a single GetItem against the same `_migration_state` partition the verbs already write). T-03-19 / T-03-20 / T-03-21 mitigations are in place via the source-scan invariants and the read-back-verify in `acquireLock`.

## TDD Gate Compliance

Both tasks ran the RED → GREEN cycle cleanly:

| Task | RED commit | GREEN commit |
|------|-----------|--------------|
| 1 (helpers + acquire + unlock + barrel) | `179cea9 test(03-04): RED — failing tests for staleCutoffIso + readLockRow` | `1d524d7 feat(03-04): GREEN — pure helpers + acquireLock + forceUnlock + barrel` |
| 2 (heartbeat + source-scan invariants) | `a511dce test(03-04): RED — failing heartbeat tests + source-scan invariant tests` | `2b70bec feat(03-04): GREEN — startLockHeartbeat wrapper (≤40 lines, ≤zero setInterval)` |

Note on the source-scan tests in Task 2's RED commit: those tests were GREEN immediately (the lock subsystem from Task 1 already complies). This is intentional — the invariant tests are designed to PROVE the subsystem complies, not to start RED. Plan 03-04 acceptance criterion: "`pnpm vitest run tests/unit/lock/source-scan.test.ts` exits 0 (the invariants are GREEN — meaning the lock subsystem complies)".

No REFACTOR commit was needed — biome auto-format ran inline during GREEN and the formatting fix was incorporated before commit.

## Self-Check: PASSED

- `src/lock/stale-cutoff.ts` exists ✓
- `src/lock/read-lock-row.ts` exists ✓
- `src/lock/acquire.ts` exists ✓
- `src/lock/unlock.ts` exists ✓
- `src/lock/heartbeat.ts` exists ✓ (36 lines, ≤40 cap)
- `src/lock/index.ts` exists ✓ (5 exports: acquireLock, startLockHeartbeat, forceUnlock, readLockRow, staleCutoffIso + types)
- `tests/unit/lock/stale-cutoff.test.ts` exists ✓
- `tests/unit/lock/read-lock-row.test.ts` exists ✓
- `tests/unit/lock/heartbeat.test.ts` exists ✓
- `tests/unit/lock/source-scan.test.ts` exists ✓
- All 4 commits exist in git log:
  - `179cea9` test(03-04): RED — staleCutoffIso + readLockRow ✓
  - `1d524d7` feat(03-04): GREEN — pure helpers + acquireLock + forceUnlock + barrel ✓
  - `a511dce` test(03-04): RED — heartbeat + source-scan invariants ✓
  - `2b70bec` feat(03-04): GREEN — startLockHeartbeat wrapper ✓
- `pnpm vitest run tests/unit/lock/` → 16 / 16 passing ✓
- `pnpm vitest run` (full suite) → 542 / 542 passing ✓
- `pnpm typecheck` exits 0 ✓
- `pnpm exec biome check ./src/lock ./tests/unit/lock` exits 0 ✓
- Source-scan invariants GREEN (no `setInterval` outside comments; no inline `consistent: true`; every `migrationState.get(` uses CONSISTENT_READ) ✓
- `wc -l src/lock/heartbeat.ts` returns 36 (≤40) ✓
- No stub patterns (TODO/FIXME/placeholder) under `src/lock/` ✓
- Plan 05 import path `import { readLockRow } from '../lock/read-lock-row.js'` is now resolvable ✓

---
*Phase: 03-internal-entities-lock-guard*
*Completed: 2026-05-08*
