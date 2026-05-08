---
phase: 03-internal-entities-lock-guard
plan: 03
subsystem: state-mutations
tags: [electrodb, dynamodb, transactWrite, conditional-write, lock-state-machine, condition-expression, pitfall-7, pitfall-5]
requires:
  - phase: 03-internal-entities-lock-guard
    plan: 03-02
    provides: MigrationsServiceBundle, MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, MIGRATION_RUNS_SCHEMA_VERSION, lockState 'dying' enum value
  - phase: 01-foundation-safety-primitives
    provides: CONSISTENT_READ named constant, EDBMigrationLockHeldError, ResolvedConfig.lock.staleThresholdMs
provides:
  - state-mutations-module
  - acquire (LCK-01, LCK-03)
  - heartbeat (Pitfall #5 lockRunId condition)
  - transitionToReleaseMode (LCK-05)
  - clear (LCK-09)
  - markFailed (LCK-10 abort path)
  - appendInFlight (multi-migration batch step)
  - unlock (LCK-08 state-aware admin path)
  - isConditionalCheckFailed, extractCancellationReason (Pitfall #7 helpers)
  - Pitfall #7 item-order convention (state, migrations, runs)
affects:
  - 03-04 lock (orchestrator that calls acquire/heartbeat/unlock through these verbs)
  - 03-06 lock-integration-tests (asserts the rendered ConditionExpression strings against DDB Local)
  - 04-runner (apply-batch loop calls acquire → transition → appendInFlight → acquire …)
  - 05-rollback (calls transitionToReleaseMode with outcome='reverted' + rollbackStrategy)
  - 09-getRunStatus (relies on `_migration_runs.lastHeartbeatAt` written by transition + markFailed)
tech-stack:
  added: []
  patterns:
    - "Each state-mutations verb is exactly ONE service.transaction.write(...) of 1–3 items (Pitfall #4)"
    - "Item order is fixed across verbs: _migration_state at index 0, _migrations at 1, _migration_runs at 2 — encoded so cancellation extraction (Pitfall #7) can assume index 0 is the lock-row diagnosis"
    - "ConditionalCheckFailed detection uses err.name + CancellationReasons[0].Code — never instanceof, never regex on err.message (Pitfall #15)"
    - "where-callbacks compose ConditionExpression as template strings via op.eq/op.lt/op.notExists (no proxied operator nesting)"
key-files:
  created:
    - src/state-mutations/cancellation.ts
    - src/state-mutations/acquire.ts
    - src/state-mutations/heartbeat.ts
    - src/state-mutations/transition.ts
    - src/state-mutations/clear.ts
    - src/state-mutations/mark-failed.ts
    - src/state-mutations/append-in-flight.ts
    - src/state-mutations/unlock.ts
    - src/state-mutations/index.ts
    - tests/unit/state-mutations/_stub-service.ts
    - tests/unit/state-mutations/cancellation.test.ts
    - tests/unit/state-mutations/acquire.test.ts
    - tests/unit/state-mutations/heartbeat.test.ts
    - tests/unit/state-mutations/transition.test.ts
    - tests/unit/state-mutations/clear.test.ts
    - tests/unit/state-mutations/mark-failed.test.ts
    - tests/unit/state-mutations/append-in-flight.test.ts
    - tests/unit/state-mutations/unlock.test.ts
    - src/internal-entities/types.ts (deviation — see below)
    - src/internal-entities/migration-state.ts (deviation — see below)
    - src/internal-entities/migrations.ts (deviation — see below)
    - src/internal-entities/migration-runs.ts (deviation — see below)
    - src/internal-entities/service.ts (deviation — see below)
    - src/internal-entities/index.ts (deviation — see below)
  modified: []
  deleted: []
decisions:
  - "ElectroDB op.contains(list, attr) signature does NOT exist — contains(name, value) is set/string containment, opposite direction. The takeover IN-clause is composed as a four-way OR; functionally equivalent ConditionExpression."
  - "size(inFlightIds) = 0 in clear.ts is implemented as op.notExists(inFlightIds) because (a) DDB removes empty sets so the conditions are equivalent, and (b) op.size does not have canNest:true in ElectroDB so it can't be passed through op.eq."
  - "ALL_OLD return on item 0 of acquire uses ElectroDB's response: 'all_old' option, which the v3 entity body translates to ReturnValuesOnConditionCheckFailure: 'ALL_OLD' specifically inside transactWrite contexts (electrodb/src/entity.js:1747-1750)."
  - "unlock's release/failed branch performs a forced clear (one ElectroDB patch().go()) rather than reusing clear() — the forced-clear must succeed even when inFlightIds is non-empty, so the LCK-09 condition is intentionally bypassed."
  - "markFailed's cause serialization is duck-typed (no instanceof Error) for consistency with the Pitfall #15 / README §9.1 dual-package guidance."
metrics:
  tasks_completed: 2
  tasks_total: 2
  unit_tests_added: 68
  unit_tests_total: 492
  files_changed: 25
  lines_added: 1668
  lines_removed: 0
  completed: "2026-05-08"
---

# Phase 3 Plan 03: state-mutations verbs Summary

**One-liner:** Eight transactWrite-issuing verbs that own every framework write to `_migration_state` / `_migrations` / `_migration_runs`, each one a single 1–3-item transactWrite with a documented ConditionExpression and a fixed item-order convention so cancellation diagnosis is always at index 0.

## What Was Done

### The Seven Verbs

Every verb in this plan is exactly ONE `service.transaction.write([...]).go()` call (or, for the three single-entity verbs, one `migrationState.patch(...).go()` call). Item count is bounded to 3 — well under DDB's 100-item transactWrite limit — and the item order is fixed across the suite so the cancellation helpers in `cancellation.ts` can attribute item 0 to the lock-row mutation by convention (Pitfall #7).

| Verb | Items | Item 0 | Item 1 | Item 2 | ConditionExpression on item 0 |
|------|-------|--------|--------|--------|-------------------------------|
| `acquire` | 2 | `_migration_state` patch | `_migration_runs` put | — | `notExists(lockState) OR lockState='free' OR ((lockState='apply' OR ='rollback' OR ='finalize' OR ='dying') AND heartbeatAt<:staleCutoff)` |
| `heartbeat` | 1 | `_migration_state` patch | — | — | `lockRunId=:runId AND (lockState='apply' OR ='rollback' OR ='finalize' OR ='dying')` |
| `transitionToReleaseMode` | 3 | `_migration_state` patch | `_migrations` patch | `_migration_runs` patch | `lockRunId=:runId AND (lockState='apply' OR ='rollback')` |
| `clear` | 1 | `_migration_state` patch | — | — | `lockState='release' AND lockRunId=:runId AND attribute_not_exists(inFlightIds)` |
| `markFailed` | 2 | `_migration_state` patch | `_migration_runs` patch | — | `lockRunId=:runId` |
| `appendInFlight` | 1 | `_migration_state` patch | — | — | `lockRunId=:runId` |
| `unlock` | 0–2 (state-dependent) | (`get` first; then) `markFailed` (active) or forced clear (release/failed) or no-op (free) | — | — | varies by branch (`lockRunId=:runId` for the forced-clear path) |

The `cancellation.ts` helper plus the seven verbs are exported from `src/state-mutations/index.ts` as the only public surface of the module.

### `cancellation.ts` — Pitfall #7 helpers

Two duck-typed helpers consumed by `acquire` and the integration tests in Plan 06:

- `isConditionalCheckFailed(err)` — returns `true` iff `err.name === 'TransactionCanceledException'` AND `err.CancellationReasons[0]?.Code === 'ConditionalCheckFailed'`. **Reads `err.name`; never regexes on `err.message`.** AWS SDK v3 sets `.name` reliably; the message format may shift between minor versions. **Avoids identity-checks against the SDK's concrete classes** (the `instanceof` trap from Pitfall #15: dual ESM/CJS loading creates two class identities; the check fails silently).
- `extractCancellationReason(err)` — returns `{ index: 0, code, item? }` or `null`. The `item` field carries `ALL_OLD` when DDB supplies it (DDB Local may omit per Assumption A9; real AWS populates when the verb commits with `response: 'all_old'`).

### `acquire` — the highest-stakes verb (LCK-01, LCK-03)

Single 2-item transactWrite. Item 0 is the `_migration_state` patch with the seven canonical lock-holder fields plus `inFlightIds += migId`; item 1 is the `_migration_runs` put with `status='running'`. On `TransactionCanceledException` whose item-0 reason is `ConditionalCheckFailed`, throws `EDBMigrationLockHeldError` carrying the current-holder details from `CancellationReasons[0].Item`.

The where-callback's takeover state filter is **not** the README's literal `IN ('apply','rollback','finalize','dying')` — see Deviation 2 below for why and what was used.

The takeover state filter explicitly excludes `'release'` and `'failed'` — those require explicit `unlock` (LCK-08). A unit test asserts that the rendered condition string contains `'apply'`, `'rollback'`, `'finalize'`, `'dying'` AND does NOT contain `eq(lockState,"release")` or `eq(lockState,"failed")` (T-03-13 mitigation).

The commit option `response: 'all_old'` (ElectroDB's typed surface) routes to `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` specifically because `context.operation === MethodTypes.transactWrite` is the trigger inside `electrodb/src/entity.js:1747-1750`.

### `heartbeat` — Pitfall #5 mitigation

1-item `migrationState.patch().set({heartbeatAt, updatedAt}).where(lockRunId = :myRunId AND lockState IN active).go()`. The `lockRunId` clause is the load-bearing piece: after `unlock --run-id <prev>` and a re-acquire by a new runner, the prior runner's stale heartbeat tick MUST NOT land on the new lock row. The runId condition guarantees the prior runner's write fails with `ConditionalCheckFailedException`, which `startHeartbeatScheduler` (Phase 1) counts toward `maxConsecutiveFailures: 2` (LCK-10 abort path). T-03-14 mitigation. **No try/catch** — swallowing the throw would defeat the LCK-10 abort.

### `transitionToReleaseMode` — release-mode handoff (LCK-05)

3-item transactWrite at the migration boundary:
- Item 0: `_migration_state` patch — `lockState='release'`, `inFlightIds -= migId`, `releaseIds += migId`.
- Item 1: `_migrations` patch — `status` flips to `'applied'` (with `appliedAt`/`appliedRunId`) or `'reverted'` (with `revertedAt`/`revertedRunId`); optional `itemCounts` and `rollbackStrategy` if provided.
- Item 2: `_migration_runs` patch — `status='completed'`, `completedAt=now`, `lastHeartbeatAt=now`.

ConditionExpression on item 0 is `lockRunId = :runId AND (lockState='apply' OR lockState='rollback')` — only the runner that owns the lock can transition, and only from an active migration state (rejects double-transitions and admin races).

The multi-migration apply-batch loop (Phase 4) calls this verb at each migration boundary, then `acquire(mode='apply')` on the next pending migration. Phase 3 doesn't model the loop — it just exposes the verb.

### `clear` (LCK-09)

1-item transactWrite that flips `_migration_state` back to `'free'` and removes the lock-holder fields. ConditionExpression refuses the clear unless `lockState='release'` AND `lockRunId=:runId` AND `inFlightIds` is empty (LCK-09: release refused while in-flight non-empty). See Deviation 3 below for why `attribute_not_exists(inFlightIds)` is used instead of `size(inFlightIds) = 0`.

### `markFailed` (LCK-10)

2-item transactWrite issued by both the heartbeat watchdog (after exceeding `maxConsecutiveFailures`) and the `unlock` verb's active-state branches. Item 0 sets `lockState='failed'` and (if `migId` provided) appends to `failedIds`; item 1 closes the run with a `{code, message}` error map. Cause serialization is duck-typed (Deviation 4).

### `appendInFlight` — multi-migration batch step

1-item patch invoked by Phase 4's apply-batch loop after a release-mode handoff: the lock has been re-acquired (still held by the same `runId`), and the runner advances its in-flight pointer (`lockMigrationId = newMigId`, `inFlightIds += newMigId`). `lockRunId = :runId` defends against an operator unlock racing with the loop.

### `unlock` (LCK-08)

The admin-path state-aware verb. Reads the lock row ONCE with `consistent: CONSISTENT_READ` (the named import — LCK-07 enforcement begins here), then dispatches per the truth table:

| `priorState` | Action |
|--------------|--------|
| `apply`, `rollback`, `finalize`, `dying` | `markFailed` dispatch (a 2-item transactWrite) |
| `release`, `failed` | Forced clear (single `migrationState.patch().go()`) — bypasses LCK-09 inFlightIds check |
| `free` | No-op; returns `{priorState: 'free'}` |

`clear` is intentionally NOT reused for the forced-clear path — `clear`'s ConditionExpression includes `attribute_not_exists(inFlightIds)`, which would refuse the operator's escape-hatch use case where `inFlightIds` is exactly what's stuck. The trust boundary "operator with table access can clear the lock" is already given by IAM (T-03-18 disposition).

### `index.ts` (barrel)

Named-only exports (no `export *`), mirroring `src/safety/index.ts`:

```typescript
export { acquire, type AcquireArgs } from './acquire.js';
export { heartbeat, type HeartbeatArgs } from './heartbeat.js';
export { transitionToReleaseMode, type TransitionArgs } from './transition.js';
export { clear, type ClearArgs } from './clear.js';
export { markFailed, type MarkFailedArgs } from './mark-failed.js';
export { appendInFlight, type AppendInFlightArgs } from './append-in-flight.js';
export { unlock, type UnlockArgs, type UnlockResult } from './unlock.js';
export {
  isConditionalCheckFailed,
  extractCancellationReason,
  type CancellationReason,
} from './cancellation.js';
```

### Unit Tests (68 added)

All eight test files use a shared `_stub-service.ts` helper that records every chained operation (`patch`, `set`, `add`, `delete`, `remove`, `where`, `commit`, `go`, `put`, `get`) so each test asserts SHAPE — item count, ordering, set fields, where-clause body substrings, error translation — without a real DDB roundtrip. Plan 06 covers the rendered ConditionExpression in integration.

| Test file | Tests | Covers |
|-----------|-------|--------|
| `cancellation.test.ts` | 16 | Pitfall #7 item-0 attribution; rejects `name=undefined`/non-objects/regex-on-message; ALL_OLD vs no-ALL_OLD branches |
| `acquire.test.ts` | 11 | 2-item ordering; canonical set fields; `inFlightIds += migId`; ConditionExpression contains the four active states + `notExists` + `'free'`; excludes `release`/`failed` from takeover; ALL_OLD-derived `EDBMigrationLockHeldError`; verbatim rethrow on non-cancellation |
| `heartbeat.test.ts` | 5 | Single patch (no transactWrite); only `heartbeatAt`/`updatedAt` set; `lockRunId` equality in where-clause; four-active-state filter; ConditionalCheckFailedException propagates verbatim |
| `transition.test.ts` | 9 | 3-item ordering; `lockState='release'`, `inFlightIds → releaseIds` swap; `applied` vs `reverted` outcome branches; `itemCounts`/`rollbackStrategy` forwarding; runs row gets `completedAt` + `lastHeartbeatAt` |
| `clear.test.ts` | 4 | Single 1-item transactWrite; `lockState='free'`; removes the five lock-holder fields; ConditionExpression mentions `release`/`lockRunId`/`inFlightIds` (LCK-09) |
| `mark-failed.test.ts` | 10 | 2-item ordering; `lockState='failed'`; error map serialization (`Error` with `.code`/`.name`/`Unknown` fallbacks); optional `failedIds += migId` based on whether `migId` was provided |
| `append-in-flight.test.ts` | 4 | Single patch; `inFlightIds += migId`; `lockMigrationId` updated; `lockRunId` equality |
| `unlock.test.ts` | 9 | All 7 lockState branches (free no-op, four active → markFailed, release/failed → forced clear); `consistent: true` on the get; forced-clear ConditionExpression has `lockRunId` but NOT `size(inFlightIds)` |

68 / 68 pass; full suite 492 / 492; `pnpm typecheck` clean; `pnpm exec biome check ./src/state-mutations ./src/internal-entities ./tests/unit/state-mutations` clean.

## Source-Scan Invariants (Plan 04 will gate on these)

```
grep -rn 'instanceof' src/state-mutations/      → 0 matches
grep -rn 'error\.message' src/state-mutations/  → 0 matches
grep -rn "from '\.\./entities/" src/state-mutations/  → 0 matches (uses ../internal-entities/)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `src/internal-entities/` did not exist when this worktree spawned**

- **Found during:** Initial setup, before any task started.
- **Issue:** Plan 03-03's `depends_on: [03-01, 03-02]` requires `src/internal-entities/` (the barrel that exports `MigrationsServiceBundle`, `MIGRATION_STATE_ID`, `STATE_SCHEMA_VERSION`, `MIGRATION_RUNS_SCHEMA_VERSION`). Plan 03-02 produces it via `git mv` from the throwaway `src/entities/` plus a 6-attribute delta set, but the orchestrator launched 03-03 in wave 1 before 03-02's commits had landed in this worktree's base. The plan's import paths do not resolve without the directory.
- **Fix:** Materialized `src/internal-entities/` locally per the verbatim content prescribed in 03-PATTERNS.md lines 98–292 (migration-state.ts with `'dying'` lockState; migrations.ts with `reads`/`rollbackStrategy`/`hasDown`/`hasRollbackResolver`; migration-runs.ts with `lastHeartbeatAt`; service.ts and types.ts and the barrel). The five field deltas match the spec.
- **Files created:** `src/internal-entities/{types,migration-state,migrations,migration-runs,service,index}.ts`
- **Commit:** `05c91ee chore(03-03): scaffold src/internal-entities/ shim …`
- **Merge implication:** When the orchestrator merges 03-02 first (it should have arrived at the merge queue before 03-03), the `src/internal-entities/` files will conflict cleanly: 03-02 writes essentially the same files via `git mv` from `src/entities/`. The 03-02 version takes precedence (it carries the full original commentary plus the test-introspection accessors); 03-03's scaffolding is functionally identical and can be discarded in favor of it. The `src/entities/` deletion (also from 03-02) is not done in this worktree to keep the merge minimal — the orchestrator's 03-02 merge will perform it.

**2. [Rule 3 - Blocking] `op.contains([list], attr)` IN-clause syntax does not exist in ElectroDB**

- **Found during:** Task 1, before writing acquire.ts.
- **Issue:** The plan (and the WAVE0 spike per 03-01-SUMMARY.md key-decisions) optimistically assumed `op.contains(['apply','rollback','finalize','dying'], lockState)` could express the takeover state filter. ElectroDB's `op.contains(name, value)` (verified in `node_modules/electrodb/src/filterOperations.js:80-85` and `index.d.ts:5213-5220`) is `contains(name, value)` — the DDB function for substring/element containment, the **opposite** semantic direction (does `name` contain `value`?). It cannot express "is `attr` IN this set of literals". The 03-01 spike conclusion that "all four candidate operators (eq, notExists, lt, contains) USABLE" is only correct for ElectroDB's actual `contains` semantic (set-element membership of a single value), not for the README/plan's intended IN-clause use.
- **Fix:** Took the WAVE0 fallback path documented in 03-PATTERNS.md line 330: composed the IN-clause as a four-way OR — `(${op.eq(lockState, 'apply')} OR ${op.eq(lockState, 'rollback')} OR ${op.eq(lockState, 'finalize')} OR ${op.eq(lockState, 'dying')})`. Functionally equivalent ConditionExpression at the DDB level. Documented in `acquire.ts` and `heartbeat.ts` JSDocs. No raw UpdateCommand fallback was needed — the OR composition works inside ElectroDB's where-callback because the callback returns a string and ElectroDB only inspects which `op.*` calls happened (to populate `ExpressionAttributeNames`/`Values`), not the rendered string structure.
- **Files affected:** `src/state-mutations/acquire.ts`, `src/state-mutations/heartbeat.ts`
- **Commits:** `8eb7824` (acquire), `353e66e` (heartbeat)

**3. [Rule 3 - Blocking] `op.size(...)` does not compose with `op.eq(...)` in ElectroDB's where-callback**

- **Found during:** Task 2, while implementing clear.ts.
- **Issue:** The plan's clear.ts where-clause was `${op.eq(lockState, 'release')} AND ${op.eq(lockRunId, args.runId)} AND ${op.eq(op.size(inFlightIds), 0)}`. ElectroDB's `op.size` (`filterOperations.js:8-13`) does not have `canNest: true`, so passing its output (a string like `"size(#a)"`) into `op.eq` doesn't get registered as an attribute proxy — the proxy sees the wrong shape and returns `""`, dropping the entire size check. There's no clean ElectroDB-native way to express `size(attr) = 0` as a where-clause term that survives the proxy.
- **Fix:** Replaced `op.eq(op.size(inFlightIds), 0)` with `op.notExists(inFlightIds)`. **DynamoDB's set-type semantics make these conditions equivalent:** when the last element is removed via `delete({inFlightIds: [...]})`, DDB removes the attribute entirely (DDB does NOT store empty sets). So `attribute_not_exists(inFlightIds)` matches exactly when `size(inFlightIds) = 0` would have. Documented in `clear.ts` JSDoc.
- **Files affected:** `src/state-mutations/clear.ts`
- **Commit:** `353e66e`

**4. [Rule 1 - Bug] Plan's test asserted `code: 'EDB_LOCK_HELD'` but the framework's actual code is `'EDB_MIGRATION_LOCK_HELD'`**

- **Found during:** Task 1, while writing the acquire test.
- **Issue:** The plan's example test (lines 437–443 of 03-03-PLAN.md) expected `expect(...).toMatchObject({code: 'EDB_LOCK_HELD', ...})`. The actual `ERROR_CODES.LOCK_HELD` constant in `src/errors/codes.ts` line 12 is `'EDB_MIGRATION_LOCK_HELD'`. Using the plan's literal would produce a green test that passes against a non-existent code.
- **Fix:** Test expects `code: 'EDB_MIGRATION_LOCK_HELD'` — sourced from the same `ERROR_CODES.LOCK_HELD` constant the framework uses. Pitfall #8 (typo at one site or the other) is the explicit reason `errors/codes.ts` is the single source of truth.
- **Files affected:** `tests/unit/state-mutations/acquire.test.ts`
- **Commit:** `a4c0c35`

**5. [Rule 2 - Critical] Plan's `commit({ returnValuesOnConditionCheckFailure: 'ALL_OLD' })` is not a real ElectroDB option**

- **Found during:** Task 1, on first typecheck after writing acquire.ts.
- **Issue:** ElectroDB's `TransactWriteQueryOptions` (`index.d.ts:2864-2874`) does not have a `returnValuesOnConditionCheckFailure` field. The lowercase camelCase version of the DDB API parameter doesn't exist there.
- **Fix:** ElectroDB's typed surface for `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` is `response: 'all_old'`. The runtime code (`electrodb/src/entity.js:1747-1750`) translates `format = 'all_old'` to `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` specifically when `context.operation === MethodTypes.transactWrite` — exactly our use case. Updated `acquire.ts` and the corresponding test assertion.
- **Files affected:** `src/state-mutations/acquire.ts`, `tests/unit/state-mutations/acquire.test.ts`
- **Commit:** `8eb7824`

### Authentication Gates

None — this plan has no external-service auth surface.

## Threat Surface Scan

No new network endpoints, file-access patterns, schema changes at trust boundaries, or auth paths introduced beyond what the plan's `<threat_model>` already enumerates. All new surface is within the framework's own DDB-write boundary, and the plan's STRIDE register covers it (T-03-13 through T-03-18).

## TDD Gate Compliance

Both tasks ran the RED → GREEN cycle:

| Task | RED (failing test) commit | GREEN (implementation) commit |
|------|---------------------------|-------------------------------|
| 1 | `a4c0c35 test(03-03): add failing tests for cancellation helpers + acquire verb` | `8eb7824 feat(03-03): implement cancellation helpers + acquire verb` |
| 2 | `ea0aa8f test(03-03): add failing tests for heartbeat/transition/clear/mark-failed/append-in-flight/unlock` | `353e66e feat(03-03): implement six remaining state-mutations verbs + barrel` |

No REFACTOR commit — biome auto-format ran during GREEN and was incorporated into the GREEN commits to keep the diff narrative simple.

## Self-Check: PASSED

- All 9 source files in `src/state-mutations/` exist (verified via `ls`)
- All 8 unit-test files in `tests/unit/state-mutations/` exist plus `_stub-service.ts` helper (verified via `ls`)
- All 5 commits exist in git log:
  - `05c91ee` chore(03-03): scaffold src/internal-entities/ shim
  - `a4c0c35` test(03-03): RED — cancellation + acquire
  - `8eb7824` feat(03-03): GREEN — cancellation + acquire
  - `ea0aa8f` test(03-03): RED — six remaining verbs
  - `353e66e` feat(03-03): GREEN — six remaining verbs + barrel
- 492 / 492 unit tests pass
- `pnpm typecheck` exits 0
- `biome check ./src/state-mutations ./src/internal-entities ./tests/unit/state-mutations` exits 0
- `grep -rn 'instanceof' src/state-mutations/` → 0 matches
- `grep -rn 'error\.message' src/state-mutations/` → 0 matches
- `grep -rn "from '\.\./entities/" src/state-mutations/` → 0 matches
