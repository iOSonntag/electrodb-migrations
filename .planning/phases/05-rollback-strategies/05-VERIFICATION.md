---
phase: 05-rollback-strategies
verified: 2026-05-09T18:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
---

# Phase 5: Rollback Strategies — Verification Report

**Phase Goal:** A user can run `npx electrodb-migrations rollback <id>` against the head migration and recover from any of the three lifecycle cases, choosing among four strategies (`projected`, `snapshot`, `fill-only`, `custom`) with explicit refusal cases when a strategy is impossible — and recover from a stuck lock via `unlock`.

**Verified:** 2026-05-09
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Pre-release rollback (Case 1) deletes every v2 record without invoking `down()`; v1 intact; `down`-less migrations succeed. | VERIFIED | `src/rollback/case-1-flow.ts` scans `migration.to` and deletes all v2 records; `migration.down` is never accessed. `tests/integration/rollback/case-1.test.ts` uses the `'no-down'` fixture and asserts `postV1.data.length === 5` (unchanged) and `postV2.data.length === 0`. |
| 2 | Post-release rollback with `--strategy projected` (default) on a STD fixture classifies records into A/B/C using frozen ElectroDB v1/v2 identity stamps (not raw pk/sk), runs `down(v2)` for A/B, deletes v1 mirror for C; type-table counts match a hand-computed expected matrix. | VERIFIED | `src/rollback/type-table.ts` uses `entity.scan` (identity-stamp-filtered) and `extractDomainKey` (domain-composite, not raw pk/sk). `src/rollback/strategies/projected.ts` calls `down(v2)` for A/B and pushes to `v1Deletes` for C. `tests/integration/rollback/std-classify.test.ts` seeds 3A+2B+2C User + 5 Team records; asserts exactly 7 entries (3A, 2B, 2C) with zero Team contamination. `tests/integration/rollback/projected.test.ts` asserts `postV1.data.length === 5` and `postV2.data.length === 5` for the 3A+2B+2C fixture. `tests/integration/cli/rollback-summary.golden.test.ts` pins individual counts: scanned=7, reverted=5, deleted=2, skipped=0, failed=0. |
| 3 | `--strategy snapshot` prints explicit B/C counts and prompts for confirmation; `--strategy fill-only` runs `down(v2)` only for B and leaves originals for A/C; `--strategy custom` invokes `rollbackResolver` per record with `{kind, v1Original, v2, down}` and respects `null` returns as deletes. | VERIFIED | `src/rollback/strategies/snapshot.ts`: buffers into A/B/C, calls `buildWarningMessage(a, b, c)` emitting B count, C count, A count to stderr; prompts via `io.confirm`. Tests pin B=2, C=2 warning text and confirm=once. `src/rollback/strategies/fill-only.ts`: only type B records invoke `down(v2)`; A and C are skipped. `src/rollback/strategies/custom.ts`: calls `resolver(buildResolverArgs(entry, migration.down))` per record; `null` returns for A/C push to `v1Deletes` (delete); for B, `null` is skipped. `tests/integration/rollback/snapshot.test.ts`, `fill-only.test.ts`, `custom.test.ts` all pass with correct counts. |
| 4 | Post-finalize with snapshot/fill-only → `EDBRollbackNotPossibleError({reason:'FINALIZED_ONLY_PROJECTED'})`; non-head rollback → `EDBRollbackOutOfOrderError`; projected without `down` → `EDBRollbackNotPossibleError({reason:'NO_DOWN_FUNCTION'})`; custom without `rollbackResolver` → `EDBRollbackNotPossibleError({reason:'NO_RESOLVER'})`. | VERIFIED | `src/rollback/preconditions.ts` Step 8 checks `lifecycleCase === 'case-3'` with `strategy === 'snapshot'` or `'fill-only'` → `FINALIZED_ONLY_PROJECTED`. Step 5 calls `findHeadViolation` → `EDBRollbackOutOfOrderError`. Step 9 checks `!migration.down` for projected/fill-only → `NO_DOWN_FUNCTION`; `!migration.rollbackResolver` for custom → `NO_RESOLVER`. Integration tests at `snapshot.test.ts:263-283` (finalized snapshot), `fill-only.test.ts:117-135` (finalized fill-only), `rollback-cli.test.ts:228-265` (out-of-order) each assert the correct error shape. |
| 5 | `unlock --run-id <runId>` requires `--run-id` even with `--yes`; the prompt shows lockState/lockHolder/lockRunId/heartbeatAt/elapsed; clearing apply→failed, release→free, finalize→failed. | VERIFIED | `src/cli/commands/unlock.ts:185` uses `.requiredOption('--run-id <runId>', ...)`. `renderLockTable` renders rows: lockState, lockHolder, lockRunId, lockMigrationId, heartbeatAt (with age), elapsed runtime. `runUnlock` renders the table before prompt and before `--yes` bypass (line 78). Four-cell truth table verified by `tests/integration/cli/unlock-cli.test.ts`: Cell #1 (apply→failed+OQ2), Cell #2 (release→free, no OQ2), Cell #3 (finalize→failed+OQ2), Cell #4 (rollback→failed+OQ2). |

**Score:** 5/5 truths verified

---

### Deferred Items

None. All five Success Criteria are verified in the current codebase.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/rollback/orchestrator.ts` | Rollback orchestrator entry point | VERIFIED | 286 lines; full lock-cycle with preconditions gate, lock+heartbeat, sleep, case dispatch, audit invariant, transitionToReleaseMode, markFailed on error. |
| `src/rollback/preconditions.ts` | Pre-execution decision gate | VERIFIED | Steps 1-10; all four refusal codes (FINALIZED_ONLY_PROJECTED, NO_DOWN_FUNCTION, NO_RESOLVER, EDBRollbackOutOfOrderError). |
| `src/rollback/type-table.ts` | Type-table classifier (A/B/C) | VERIFIED | Two-scan union strategy using identity-stamp-filtered ElectroDB entity scans and domain-key indexing. |
| `src/rollback/identity-stamp.ts` | Identity-stamp utilities | VERIFIED | `classifyOwner` via `entity.ownsItem`; `extractDomainKey` via schema.indexes.byId.pk.composite. |
| `src/rollback/case-1-flow.ts` | Pre-release (Case 1) lossless delete | VERIFIED | Scans `migration.to`, batch-deletes v2; `migration.down` never accessed. |
| `src/rollback/strategies/projected.ts` | Projected strategy | VERIFIED | A/B: calls `down(v2)`; C: push to v1Deletes. |
| `src/rollback/strategies/snapshot.ts` | Snapshot strategy | VERIFIED | Buffers into A/B/C; emits warning to stderr (Pitfall 8 even with --yes); prompts; deletes type B v2 records. |
| `src/rollback/strategies/fill-only.ts` | Fill-only strategy | VERIFIED | Type B only: calls `down(v2)`; A/C skipped. |
| `src/rollback/strategies/custom.ts` | Custom strategy | VERIFIED | Per-record `rollbackResolver` dispatch; `validateResolverResult` (Pitfall 3); null→delete for A/C; null→skip for B. |
| `src/rollback/audit.ts` | Rollback audit accumulator | VERIFIED | scanned/reverted/deleted/skipped/failed counters; `assertInvariant()` for count-audit (RBK-12). |
| `src/rollback/head-only.ts` | Head-only guard | VERIFIED | `findHeadViolation` scans all rows for newer applied/finalized row for same entity. |
| `src/rollback/lifecycle-case.ts` | Lifecycle case classifier | VERIFIED | Distinguishes case-1/case-2/case-3 from targetRow.status + lockRow.lockState. |
| `src/rollback/resolver-validate.ts` | Resolver result schema validator | VERIFIED | Calls `(v1Entity as any).put(result).params()` to validate against ElectroDB schema (Pitfall 3). |
| `src/rollback/batch-flush-rollback.ts` | Heterogeneous batch flush | VERIFIED | Handles puts + v2Deletes in a single BatchWriteItem cycle with retry. |
| `src/rollback/index.ts` | Public barrel | VERIFIED | Re-exports `rollback` function and types. |
| `src/cli/commands/rollback.ts` | CLI `rollback` subcommand | VERIFIED | Registers `rollback <id>` with `--strategy` and `--yes`; calls `client.rollback`. |
| `src/cli/commands/unlock.ts` | CLI `unlock` subcommand | VERIFIED | `.requiredOption('--run-id')`, renders lock table, prompts, calls `client.forceUnlock`, patches `_migrations.status` for ACTIVE_PRIOR_STATES (OQ2). |
| `src/client/create-migrations-client.ts` | MigrationsClient extensions | VERIFIED | `rollback`, `forceUnlock`, `getLockState`, `getGuardState` added at lines 361-455. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `orchestrator.ts` | `preconditions.ts` | `checkPreconditions()` call | WIRED | Line 152-160; refusal throws before acquireLock. |
| `orchestrator.ts` | `type-table.ts` | `classifyTypeTable()` call | WIRED | Line 201-203; called for case-2/3 after lock acquired. |
| `orchestrator.ts` | `strategies/*.ts` | switch dispatch | WIRED | Lines 205-232; four strategy executors dispatched correctly. |
| `orchestrator.ts` | `case-1-flow.ts` | `rollbackCase1()` call | WIRED | Line 193-198; case-1 path. |
| `orchestrator.ts` | `audit.ts` | `createRollbackAudit()` + `audit.assertInvariant()` | WIRED | Lines 179, 239; assertInvariant before transitionToReleaseMode. |
| `preconditions.ts` | `head-only.ts` | `findHeadViolation()` call | WIRED | Line 112. |
| `preconditions.ts` | `lifecycle-case.ts` | `determineLifecycleCase()` call | WIRED | Line 127. |
| `type-table.ts` | `identity-stamp.ts` | `extractDomainKey()` calls | WIRED | Lines 126, 142. |
| `strategies/custom.ts` | `resolver-validate.ts` | `validateResolverResult()` call | WIRED | Line 161-165. |
| `cli/commands/rollback.ts` | `client/create-migrations-client.ts` | `client.rollback()` | WIRED | Line 57. |
| `cli/commands/unlock.ts` | `client/create-migrations-client.ts` | `client.forceUnlock()` + `client.getLockState()` | WIRED | Lines 68, 91. |
| `cli/commands/unlock.ts` | `__bundle` internal accessor | OQ2 patch for active states | WIRED | Lines 96-118; patches `_migrations.status='failed'` for apply/rollback/finalize priorState. |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `orchestrator.ts` | `decision` (preconditions) | `service.migrations.scan.go()` → DDB | Yes — real scan against DDB Local in integration tests | FLOWING |
| `type-table.ts` | `v1Index` / `v2 scan` | `entity.scan.go({consistent:CONSISTENT_READ})` | Yes — ElectroDB entity scan with ConsistentRead=true | FLOWING |
| `strategies/projected.ts` | `puts` / `v1Deletes` | Classifier yields + `migration.down(v2)` | Yes — real DDB reads through strategy dispatch | FLOWING |
| `cli/commands/unlock.ts` | `lock` | `client.getLockState()` → `readLockRow()` | Yes — fresh consistent read of _migration_state | FLOWING |

---

### Behavioral Spot-Checks

Integration tests exercise runnable code paths against DDB Local.

| Behavior | Test | Result | Status |
|----------|------|--------|--------|
| Case 1 lossless: v1=5, v2=0, status=reverted | `case-1.test.ts` (no-down fixture) | 5+5 → v1=5, v2=0 | PASS |
| Projected Case 2: 3A+2B+2C → v1=5, v2=5, count audit holds | `projected.test.ts` | v1=5, v2=5, scanned==sum | PASS |
| STD safety: classifier emits 7 User records, 0 Team records | `std-classify.test.ts` | 3A+2B+2C=7; no teamLabel | PASS |
| Snapshot --yes: warns to stderr; deletes 2 B records; v1=5, v2=3 | `snapshot.test.ts` | stderrText contains B/DATA LOSS counts; v1=5, v2=3 | PASS |
| Fill-only: B filled, A/C kept; v1=7, v2=5 | `fill-only.test.ts` | v1=7 (A+B+C), v2=5 | PASS |
| Custom: resolver dispatched; v1=5, v2=5 | `custom.test.ts` | v1=5, v2=5, status=reverted | PASS |
| Case 3 snapshot refusal: FINALIZED_ONLY_PROJECTED | `snapshot.test.ts` | rejects with details.reason=FINALIZED_ONLY_PROJECTED | PASS |
| Unlock apply→failed + OQ2 patch | `unlock-cli.test.ts` Cell #1 | lockState=failed, _migrations.status=failed | PASS |
| Unlock release→free, no OQ2 patch | `unlock-cli.test.ts` Cell #2 | lockState=free, _migrations.status=applied | PASS |
| Unlock finalize→failed + OQ2 patch | `unlock-cli.test.ts` Cell #3 | lockState=failed, _migrations.status=failed | PASS |
| Lock-cycle success: free→rollback→release | `lock-cycle.test.ts` | preLock=free, postLock=release | PASS |
| Lock-cycle failure: free→rollback→failed | `lock-cycle.test.ts` | postLock=failed on resolver throw | PASS |
| CLI rollback projected end-to-end | `rollback-cli.test.ts` RC-01 | status=reverted, v1=5 | PASS |
| CLI rollback out-of-order throws | `rollback-cli.test.ts` RC-02 | rejects | PASS |
| Golden summary format | `rollback-summary.golden.test.ts` | scanned:7, reverted:5, deleted:2, skipped:0, failed:0 | PASS |
| Audit-row shape (Pitfall 9 + WARNING 1) | `audit-row-shape.test.ts` | rollbackStrategy written; itemCounts.migrated=audit.reverted | PASS |

Total reported: 957/957 unit tests + 41/41 Phase 5 integration tests pass.

---

### Requirements Coverage

| Requirement | Plans | Description | Status | Evidence |
|------------|-------|-------------|--------|----------|
| RBK-01 | 05-02, 05-09 | Head-only rollback (non-head refused) | SATISFIED | `preconditions.ts` Step 5 `findHeadViolation` → `EDBRollbackOutOfOrderError`; integration test RC-02 |
| RBK-02 | 05-09 | Lock-cycle for rollback (free→rollback→release) | SATISFIED | `orchestrator.ts` Steps 2-6; `lock-cycle.test.ts` |
| RBK-03 | 05-08 | Case 1 lossless pre-release rollback | SATISFIED | `case-1-flow.ts` scans v2, deletes all; `case-1.test.ts` |
| RBK-04 | 05-03 | Type-table A/B/C classification | SATISFIED | `type-table.ts` + `identity-stamp.ts`; `std-classify.test.ts` |
| RBK-05 | 05-05 | Projected strategy: down(v2) for A/B; delete v1 mirror for C | SATISFIED | `strategies/projected.ts`; `projected.test.ts` |
| RBK-06 | 05-06 | Snapshot strategy: DATA-LOSS warning + prompt; delete type B v2 | SATISFIED | `strategies/snapshot.ts`; `snapshot.test.ts` |
| RBK-07 | 05-05 | Fill-only strategy: down(v2) for B only | SATISFIED | `strategies/fill-only.ts`; `fill-only.test.ts` |
| RBK-08 | 05-07 | Custom strategy: per-record rollbackResolver dispatch | SATISFIED | `strategies/custom.ts`; `custom.test.ts` |
| RBK-09 | 05-02 | Refusal: ALREADY_REVERTED, NOT_APPLIED | SATISFIED | `preconditions.ts` Steps 3-4 |
| RBK-10 | 05-02 | Refusal: MIGRATION_NOT_FOUND | SATISFIED | `preconditions.ts` Step 2 |
| RBK-11 | 05-03 | STD safety: identity-stamp filtering | SATISFIED | `type-table.ts` + `identity-stamp.ts`; `std-classify.test.ts` (zero Team contamination) |
| RBK-12 | 05-01, 05-04 | Count-audit invariant (scanned==reverted+deleted+skipped+failed) | SATISFIED | `audit.ts` `assertInvariant()`; all integration tests assert the invariant |
| CLI-05 | 05-11 | `unlock` subcommand | SATISFIED | `cli/commands/unlock.ts:185` `.requiredOption('--run-id')` |
| CLI-06 | 05-11 | Unlock prompt shows lock-state table | SATISFIED | `renderLockTable()` called before prompt at line 78 |
| CLI-07 | 05-11 | `--run-id` required even with `--yes` | SATISFIED | `.requiredOption` enforced by Commander at CLI registration level |
| API-05 | 05-10 | MigrationsClient: rollback, forceUnlock, getLockState, getGuardState | SATISFIED | `create-migrations-client.ts` lines 361-455 |

---

### Anti-Patterns Found

No blockers or warnings found in Phase 5 source files.

Spot-checks performed on key files:

- `src/rollback/orchestrator.ts`: `sched.stop()` in `finally{}` (Pitfall 4/10 compliance confirmed). `markFailed` in catch with `.catch()` (CR-04 mirror confirmed). No TODO/FIXME/placeholder.
- `src/rollback/strategies/projected.ts`: No empty handlers; `down!` used (preconditions guarantee it is defined). No `return null` stubs.
- `src/rollback/strategies/snapshot.ts`: Warning emitted to stderr even with `--yes` (Pitfall 8 confirmed at lines 193, 211).
- `src/cli/commands/unlock.ts`: OQ2 patch is best-effort `.catch()` (CR-04 mirror confirmed). `renderLockTable` exported for golden-file testing.
- No `CONSISTENT_READ` omissions: `type-table.ts` and `case-1-flow.ts` both import and use the `CONSISTENT_READ` constant.

---

### Human Verification Required

None. All five Success Criteria are fully verifiable programmatically via the codebase and integration test suite.

---

### Pre-Existing Integration Failures (Out of Scope for Phase 5)

Two integration test failures exist in the full suite but are **pre-existing items from Phase 4**, tracked as deferred items DI-04-15-01 and DI-04-15-02 (see `.planning/phases/04-apply-release-finalize-runner/deferred-items.md`). They are not regressions introduced by Phase 5.

- **DI-04-15-01** (`tests/integration/runner/finalize.test.ts:80`): Assertion reads `itemCounts.migrated` but should read `itemCounts.deleted` after WR-05 added a separate `deleted` slot. One-line fix; no Phase 5 code involved.
- **DI-04-15-02** (`tests/integration/runner/guarded-write-at-boundary.test.ts:191`): State-leak between integration suites (DDB Local guard-cache TTL crossover). Passes in isolation; fails only in the full suite. No Phase 5 code involved.

Both failures exist on the base commit before any Phase 5 plan ran. Phase 5 added 41 new integration tests; all 41 pass.

---

### ROADMAP Artifact Note

The ROADMAP.md Progress table still shows Phase 5 as `0/11 | Planned` — this is a documentation artifact: the ROADMAP was not updated after the phase completed. All 11 plans have SUMMARY.md files, the source code is fully present, and all tests pass. The ROADMAP checkbox (`[ ]`) is a cosmetic miss and does not reflect the actual codebase state.

---

## Gaps Summary

No gaps. All five Success Criteria are VERIFIED against the codebase:

1. Case 1 lossless pre-release rollback — implemented and integration-tested (`case-1-flow.ts`, `case-1.test.ts`).
2. Projected strategy with STD identity-stamp classification — implemented and integration-tested (`type-table.ts`, `identity-stamp.ts`, `strategies/projected.ts`, `std-classify.test.ts`, `projected.test.ts`, golden summary test).
3. Snapshot / fill-only / custom strategies with correct semantics — implemented and integration-tested (three strategy files, three integration test files).
4. All four refusal cases with correct error types and reason codes — implemented in `preconditions.ts` and tested in strategy/CLI integration tests.
5. Unlock command with `--run-id` enforced, lock-state table rendered, four-cell truth table — implemented in `cli/commands/unlock.ts` and exhaustively tested in `unlock-cli.test.ts`.

---

_Verified: 2026-05-09_
_Verifier: Claude (gsd-verifier)_
