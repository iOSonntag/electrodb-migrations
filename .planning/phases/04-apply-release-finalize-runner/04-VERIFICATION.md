---
phase: 04-apply-release-finalize-runner
verified: 2026-05-08T22:11:44Z
status: passed
score: 5/5
overrides_applied: 0
human_verification: []
auto_verification_run: 2026-05-09T00:15:00Z
auto_verification_outcome: |
  Orchestrator started DDB Local via `docker compose up -d` and ran `npm run test:integration`.
  Result: 23 integration test files / 60 tests passed, including all 8 Phase 4 runner integration
  tests. The RUN-09 stderr literal "Run `electrodb-migrations release` after deploying the new
  code" was observed in the apply-happy-path-1k test output. Both human-verification items
  satisfied automatically; status promoted from `human_needed` to `passed`.
---

# Phase 4: Apply, Release & Finalize Runner — Verification Report

**Phase Goal:** Pending migrations apply end-to-end against a real DynamoDB Local table: scan v1 records, run user `up()`, write v2 records (with the count-audit invariant enforced), transition to release-mode, hand off internally for multi-migration batches, clear with `release`, and finalize under maintenance-mode lock.
**Verified:** 2026-05-08T22:11:44Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 1,000 v1 records apply end-to-end: lock transitions free→apply→release, 1,000 v2 records written alongside v1, count audit holds, success summary with "Run `release` after deploying code" printed | VERIFIED | `apply-happy-path-1k.test.ts` pins all four sub-assertions: lock state, v1/v2 coexistence (1,000 each via ElectroDB scan), `result.applied[0].itemCounts.scanned===1000`, stderrSpy confirms the exact literal string from `renderApplySummary`. `apply-flow.ts` → `applyFlowScanWrite` drives scan+write; `count-audit.ts` enforces invariant; `apply-summary.ts` renders the checklist. |
| 2 | Two pending migrations applied in one continuous lock cycle without manual release; guarded app traffic blocked throughout including at the release-mode boundary | VERIFIED | `apply-batch.test.ts` proves `result.applied.length===2`, `releaseIds` contains both migration ids, `lockState='release'` after. `guarded-write-at-boundary.test.ts` (B-02) proves all 20 guarded writes throw `EDBMigrationInProgressError` during the multi-migration run, including writes fired after apply resolves when lock is stable in `'release'` (Decision A7). `apply-batch.ts` orchestrates continuous lock via `appendInFlight` + `transitionReleaseToApply`. |
| 3 | `apply --migration <id>` for wrong sequence position rejects with friendly error naming actual next; `apply` with no pending exits zero with "no migrations to apply" | VERIFIED | `apply-sequence-enforcement.test.ts` covers three cases: (a) future-id → `EDB_NOT_NEXT_PENDING` with remediation naming actual next id and version range; (b) unknown-id → `EDB_NOT_PENDING`; (c) pre-marked-applied migrations → `{applied:[]}` (CLI prints "No migrations to apply." and exits 0). `apply-batch.ts` lines 69-93 implement the logic. CLI `apply.ts` line 64-67 handles the no-op display. |
| 4 | `release` clears release-mode lock; second call is idempotent no-op; `finalize <id>` deletes v1 under maintenance-mode lock (app traffic unaffected), marks `finalized`, clears lock | VERIFIED | `release-clear.test.ts` covers REL-01, REL-02 (free-lock no-op, double-release idempotent, apply-state premature rejection). `finalize.test.ts` (B-01 fixture, 100 records) proves: v1=0 after finalize, v2=100 untouched, `_migrations.status='finalized'`, ISO-8601 `finalizedAt`, lock back to `'free'`. `guarded-read-during-finalize.test.ts` (B-03) proves 20 concurrent guarded GETs all succeed while finalize runs and `'finalize'` lockState was observed — Decision A7 confirmed. `clear-finalize.ts` implements the lock clear with conditional `lockState='finalize' AND lockRunId=:runId` guard. |
| 5 | `status` prints lockState/lockHolder/lockRunId/heartbeatAt/per-migration progress in cli-table3 table; `history --json` emits machine-readable JSON | VERIFIED | `status.ts` constructs two `cli-table3` tables (lock row with lockState/lockHolder/lockRunId/lockMigrationId/heartbeatAt/inFlightIds; recent migrations with id/entityName/from→to/status/appliedAt/finalizedAt). `history.ts` calls `formatHistoryJson` which produces a JSON array sorted by id with Sets→sorted arrays. `table.ts` wraps `cli-table3`. Both commands wired in `cli/index.ts` via `registerStatusCommand`/`registerHistoryCommand`. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/runner/apply-flow.ts` | Single-migration apply orchestrator (acquire lock, sleep, scan/write, transition to release) | VERIFIED | 192 lines; implements `applyFlow` + `applyFlowScanWrite`; acquireLock → startLockHeartbeat → sleep(acquireWaitMs) → scan+write loop → assertInvariant → transitionToReleaseMode. BL-01 double-write present (upsert then put) but does not break SC. |
| `src/runner/apply-batch.ts` | Multi-migration loop with continuous lock hand-off | VERIFIED | 158 lines; implements RUN-05/06/07; first migration via `applyFlow`; N>0 via `appendInFlight` + `transitionReleaseToApply` + `applyFlowScanWrite`. Empty pending returns `{applied:[]}`. Sequence enforcement via `isNextPending`. |
| `src/runner/finalize-flow.ts` | Finalize orchestrator under maintenance-mode lock | VERIFIED | 123 lines; acquires 'finalize' lock, sleeps, iterates v1 records and deletes each, patches `_migrations.status='finalized'`, calls `clearFinalizeMode`. Pitfall 7 concurrent-delete handled as `skipped`. |
| `src/runner/count-audit.ts` | Count audit invariant accumulator | VERIFIED | 43 lines; `assertInvariant` throws if `scanned !== migrated + skipped + failed`; used in both `apply-flow.ts` and `finalize-flow.ts`. |
| `src/runner/scan-pipeline.ts` | Cursor-based v1 record iterator | VERIFIED | 47 lines; async generator using ElectroDB identity-stamp scan; page-bounded at 100 records default. NOTE: no `consistent: true` on the scan (WR-09 warning) — DDB Local is strongly consistent so this does not block SC. |
| `src/runner/batch-flush.ts` | BatchWriteItem adapter with retry | VERIFIED | 71 lines; uses `withBatchWriteRetry` (Phase 1 safety primitive); marshals via ElectroDB `put().params()` for schema validation; slices to DDB 25-item limit. |
| `src/runner/apply-summary.ts` | Success summary renderer | VERIFIED | 61 lines; `renderApplySummary` produces the checklist including "Run `electrodb-migrations release` after deploying the new code" on line 51. |
| `src/runner/history-format.ts` | History JSON formatter | VERIFIED | 74 lines; `formatHistoryJson` converts Set→sorted array, sorts by id ascending, pretty-prints JSON with trailing newline. |
| `src/runner/load-pending.ts` | Disk-walk pending migration resolver | VERIFIED | 163 lines; `loadPendingMigrations` walks migrations dir, correlates against `_migrations` rows, sorts by (entityName, fromVersion). `isNextPending` implements per-entity sequence check. NOTE: WR-01 (swallows file load errors) and WR-02 (no directory filtering) present but do not break happy path. |
| `src/runner/transition-release-to-apply.ts` | Release→apply hand-off | VERIFIED | 45 lines; flips `lockState='release'→'apply'` with condition `lockRunId=:runId AND lockState='release'`. BL-03: `migId` parameter accepted but unused in WHERE clause — code smell, not SC failure. |
| `src/state-mutations/clear-finalize.ts` | Finalize-mode lock clear | VERIFIED | 49 lines; patches `lockState='free'`, removes all lock fields, with condition `lockRunId=:runId AND lockState='finalize'`. WR-03: uses substring match instead of `isConditionalCheckFailed` helper — warning only. |
| `src/cli/commands/apply.ts` | `apply` CLI command | VERIFIED | 99 lines; `registerApplyCommand` registered in `cli/index.ts`; calls `client.apply()`, handles 0-applied (RUN-07), surfaces errors with remediation. |
| `src/cli/commands/release.ts` | `release` CLI command | VERIFIED | 66 lines; `registerReleaseCommand` registered; calls `client.release()`; handles `{cleared:false}` with "no active release-mode lock" message (REL-02). |
| `src/cli/commands/finalize.ts` | `finalize` CLI command | VERIFIED | 92 lines; validates mutual exclusion of `<id>` and `--all`; dispatches to `client.finalize()`; prints per-migration bullet lines. |
| `src/cli/commands/status.ts` | `status` CLI command | VERIFIED | 130 lines; renders two cli-table3 tables (lock + recent migrations); `--json` path supported; `colorizeLockState`/`colorizeStatus` helpers. |
| `src/cli/commands/history.ts` | `history` CLI command | VERIFIED | 96 lines; calls `client.history()`, then `formatHistoryJson` for `--json` path; renders cli-table3 table for default path; `--entity` filter supported. |
| `src/client/create-migrations-client.ts` | Programmatic client factory | VERIFIED | 380 lines; `createMigrationsClient` returns `MigrationsClient` with `apply`, `finalize`, `release`, `history`, `status`, `guardedClient` methods; middleware stack isolation via `middlewareStack.clone()` (WR-04 smithy internal — warning only); `runUnguarded` wraps all bundle operations. |
| `src/cli/program.ts` | Commander program builder | VERIFIED | 51 lines; `buildProgram` accepts all 8 register callbacks. |
| `src/cli/index.ts` | CLI bin entry | VERIFIED | 79 lines; dynamically imports all 8 command modules via `tryImportRegistrar`; wires `apply`/`release`/`finalize`/`status`/`history` commands. |
| `src/index.ts` (API-06) | Public surface with `defineConfig`/`defineMigration`/`createMigrationsClient` | VERIFIED | All three exported; `createMigrationsClient` added in Phase 4 per inline JSDoc. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `cli/index.ts` | `commands/apply.ts` | `tryImportRegistrar('./commands/apply.js', 'registerApplyCommand')` | WIRED | Dynamic import resolves; `registerApplyCommand` wired to program. |
| `cli/index.ts` | `commands/release.ts` | `tryImportRegistrar('./commands/release.js', 'registerReleaseCommand')` | WIRED | Same pattern. |
| `cli/index.ts` | `commands/finalize.ts` | `tryImportRegistrar('./commands/finalize.js', 'registerFinalizeCommand')` | WIRED | Same pattern. |
| `cli/index.ts` | `commands/status.ts` | `tryImportRegistrar('./commands/status.js', 'registerStatusCommand')` | WIRED | Same pattern. |
| `cli/index.ts` | `commands/history.ts` | `tryImportRegistrar('./commands/history.js', 'registerHistoryCommand')` | WIRED | Same pattern. |
| `client/create-migrations-client.ts` | `runner/apply-batch.ts` | `import { applyBatch }` → called in `client.apply()` | WIRED | `applyBatch` called inside `runUnguarded` in `apply()` method. |
| `client/create-migrations-client.ts` | `runner/finalize-flow.ts` | `import { finalizeFlow }` → called in `client.finalize()` | WIRED | `finalizeFlow` called for both single-id and `{all:true}` paths. |
| `client/create-migrations-client.ts` | `state-mutations/clear.ts` | `import { clear }` → called in `client.release()` | WIRED | `clear(bundle, {runId})` called after `lockState='release'` confirmed. |
| `runner/apply-flow.ts` | `runner/count-audit.ts` | `import { createCountAudit }` → `audit.assertInvariant()` | WIRED | `assertInvariant()` called before `transitionToReleaseMode` in `applyFlowScanWrite`. |
| `runner/apply-flow.ts` | `runner/batch-flush.ts` | `import { batchFlushV2 }` → called per page | WIRED | `batchFlushV2` called inside the page loop with `migration.to` entity. |
| `runner/apply-flow.ts` | `state-mutations/transition.ts` | `import { transitionToReleaseMode }` → called at end | WIRED | `transitionToReleaseMode` called with `outcome:'applied'` and `itemCounts`. |
| `runner/finalize-flow.ts` | `state-mutations/clear-finalize.ts` | `import { clearFinalizeMode }` → called post-patch | WIRED | `clearFinalizeMode` called after `_migrations.status='finalized'` patch. |
| `runner/apply-batch.ts` | `runner/transition-release-to-apply.ts` | `import { transitionReleaseToApply }` → called for N>0 migrations | WIRED | Called after `appendInFlight` for migrations 2..N in the batch loop. |
| `cli/commands/apply.ts` | `client/create-migrations-client.ts` | `import { createMigrationsClient }` → `client.apply()` | WIRED | `runApply` creates client, calls `client.apply(args)`. |
| `src/index.ts` | `client/index.ts` | `export { createMigrationsClient }` | WIRED | Phase 4 addition confirmed in file. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `apply-flow.ts` `applyFlowScanWrite` | `page` (v1 records) | `iterateV1Records(args.migration)` → `migration.from.scan.go()` | Yes — real ElectroDB scan against DDB table | FLOWING |
| `apply-flow.ts` `applyFlowScanWrite` | `v2` (transformed record) | `await args.migration.up(v1, args.ctx)` | Yes — user-supplied transform function | FLOWING |
| `batch-flush.ts` | `items` (marshalled v2 records) | `entity.put(record).params()` → `BatchWriteCommand` | Yes — real DDB BatchWriteItem | FLOWING |
| `count-audit.ts` | `itemCounts` snapshot | `audit.snapshot()` → passed to `transitionToReleaseMode` → patched onto `_migrations` row | Yes — accumulated from real scan/write operations | FLOWING |
| `create-migrations-client.ts` `apply()` | `history.data` (for summary) | `bundle.migrations.scan.go({pages:'all'})` | Yes — real DDB scan of `_migrations` table | FLOWING |
| `create-migrations-client.ts` `status()` | `lock` | `readLockRow(bundle)` | Yes — real DDB GetItem on `_migration_state` | FLOWING |
| `create-migrations-client.ts` `history()` | `rows` | `bundle.migrations.scan.go({pages:'all'})` | Yes — real DDB scan | FLOWING |

### Behavioral Spot-Checks

Step 7b: SKIPPED (no runnable entry points without DDB Local — all key behaviors require the DDB connection; see Human Verification Required).

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|---------|
| RUN-01 | `apply` scans by ElectroDB identity stamps | SATISFIED | `scan-pipeline.ts` uses `migration.from.scan.go()` which filters by `__edb_e__`/`__edb_v__`; spike test `identity-stamp-scan.spike.test.ts` confirms on DDB Local |
| RUN-02 | `up()` called; v2 written alongside v1 | SATISFIED | `applyFlowScanWrite` calls `up(v1)` per record, collects v2 batch, calls `batchFlushV2`; 1k test confirms 1,000 v1 + 1,000 v2 coexist |
| RUN-03 | `BatchWriteItem` with bounded retry | SATISFIED | `batch-flush.ts` uses `withBatchWriteRetry` (Phase 1 primitive); max 5 retries, max 30s delay |
| RUN-04 | Count audit invariant enforced | SATISFIED | `count-audit.ts` `assertInvariant()` called before `transitionToReleaseMode`; 1k test asserts `scanned===migrated+skipped+failed` |
| RUN-05 | Multiple pending migrations applied back-to-back | SATISFIED | `apply-batch.ts` continuous lock cycle; `apply-batch.test.ts` proves 2 migrations in one call with `releaseIds` containing both |
| RUN-06 | `apply --migration <id>` enforces sequence | SATISFIED | `isNextPending` in `load-pending.ts`; `apply-sequence-enforcement.test.ts` covers EDB_NOT_NEXT_PENDING + EDB_NOT_PENDING |
| RUN-07 | No-op when no pending | SATISFIED | `applyBatch` line 69 returns `{applied:[]}` immediately; CLI prints "No migrations to apply." exits 0 |
| RUN-08 | On failure, marked failed; lock stays in failed | SATISFIED | `markFailed` called in catch; `apply-failure-fail-fast.test.ts` proves `lockState='failed'` and re-apply returns empty |
| RUN-09 | Success summary with count audit and release checklist | SATISFIED | `renderApplySummary` in `apply-summary.ts`; literal "Run `electrodb-migrations release`..." on line 51; client writes to stderr; 1k test spies on stderr |
| REL-01 | `release` clears release-mode lock | SATISFIED | `client.release()` reads lock row, calls `clear()`; `release-clear.test.ts` confirms `{cleared:true}` + `lockState='free'` |
| REL-02 | `release` idempotent no-op | SATISFIED | `{cleared:false, reason:'no-active-release-lock'}` when lock is free; double-release test confirms second call is no-op |
| FIN-01 | `finalize <id>` deletes v1 under maintenance-mode lock | SATISFIED | `finalizeFlow` acquires 'finalize' mode lock, iterates v1 records, deletes each; `finalize.test.ts` proves v1=0 after |
| FIN-02 | `finalize --all` finalizes every applied migration | PARTIAL | `client.finalize({all:true})` enumerates `status='applied'` rows and loops; happy path works (unit test CMC-6). BL-04: missing source file causes silent `continue` with no operator signal — violates "cannot leave table in half-migrated state without operator action". No integration test covers the `--all` path end-to-end. |
| FIN-03 | Migration marked `finalized`; lock cleared | SATISFIED | `finalizeFlow` patches `_migrations.status='finalized'` then calls `clearFinalizeMode`; `finalize.test.ts` confirms both |
| FIN-04 | Finalize irreversible by design | SATISFIED | No auto-rollback hook in `finalizeFlow`; JSDoc explicitly documents this (FIN-04); `finalize.test.ts` confirms finalize clears lock without rollback |
| CLI-03 | `status` command renders lock state + migrations table | SATISFIED | `status.ts` uses `cli-table3` for both lock row and recent migrations; lockState/lockHolder/lockRunId/heartbeatAt all rendered |
| CLI-04 | `history [--entity] [--json]` full migration log | SATISFIED | `history.ts` calls `client.history()` then `formatHistoryJson`; entity filter and JSON output both implemented |
| API-01 | `createMigrationsClient({config, client, tableName, migrations})` | SATISFIED | `create-migrations-client.ts` exports `createMigrationsClient`; re-exported from `src/index.ts` |
| API-02 | Blocking methods: `apply`, `finalize`, `release`, `history` | SATISFIED | All four methods on `MigrationsClient` interface; `status()` also present (bonus) |
| API-06 | `defineConfig` and `defineMigration` exported | SATISFIED | Both exported from `src/index.ts` (Phase 1/2 additions confirmed in place) |

### Anti-Patterns Found

| File | Location | Pattern | Severity | Impact |
|------|----------|---------|----------|--------|
| `src/runner/apply-flow.ts` | Lines 103-152 | Double-write to `_migrations` row: `upsert` (fingerprint=`'applied:<id>'`) then `put` (fingerprint=`''`) — second write overwrites first | Warning | `fingerprint` ends up as `''` post-apply instead of the documented placeholder. `itemCounts`, `status`, and `appliedAt` are correctly set by `transitionToReleaseMode`'s patch. No SC failure but extra DDB round trip and misleading audit row pre-Phase 7. |
| `src/runner/apply-batch.ts` | Line 69 | When `pending.length===0` and `migrationId` is set, returns `{applied:[]}` silently; CLI prints "No migrations to apply." obscuring that the user's explicit target was not applied | Warning | BL-02: misleading UX when user specifies an already-applied migration id. Not a SC failure (SC#3 covers sequence enforcement, not already-applied detection). |
| `src/runner/transition-release-to-apply.ts` | Lines 11, 41-43 | `migId` parameter accepted but not used in the WHERE clause; WHERE only checks `lockRunId=:runId AND lockState='release'` | Warning | BL-03: code smell — future maintainer risk if call order changes. No current SC failure. |
| `src/client/create-migrations-client.ts` | Line 227 | `finalize({all:true})` silently `continue`s when migration source is missing; no log, no error, no returned-result entry | Warning | BL-04: FIN-02 partial — operator has no signal that finalization was incomplete. Affects `finalize --all` error path only; happy path (all sources available) works correctly. |
| `src/runner/load-pending.ts` | Line 93 | `.catch(() => null)` swallows all file load errors including syntax errors and missing imports | Warning | WR-01: user gets "No migrations to apply" on broken migration files instead of an error. Phase 7 validate is the intended reporter but Phase 7 hasn't shipped yet. |
| `src/runner/scan-pipeline.ts` | Line 42 | `v1.scan.go({cursor, limit})` without `consistent: true` | Warning | WR-09: eventually consistent scan during apply. DDB Local is strongly consistent so integration tests are unaffected. Production risk: record visible between `acquireLock` and the scan window could be skipped. Low probability due to lock-mode gating but not zero. |
| `src/state-mutations/clear-finalize.ts` | Lines 43-47 | Substring `includes('ConditionalCheckFailed')` instead of canonical `isConditionalCheckFailed` helper | Info | WR-03: fragile across AWS SDK versions. Functional for v0.1 but should use the shared helper. |
| `src/client/create-migrations-client.ts` | Lines 88-100 | `middlewareStack.clone()` is a smithy internal not exposed in TS types | Info | WR-04: silent breakage risk on AWS SDK minor updates. Mitigated by the comment block's explicit documentation. |

### Human Verification Required

#### 1. Full Integration Test Suite Against DDB Local

**Test:** Start DynamoDB Local (via `docker compose up -d`) then run `pnpm vitest run --config vitest.integration.config.ts`
**Expected:** All 10 integration test files in `tests/integration/runner/` pass with zero skips (DDB Local reachable). Specific SC-proving tests:
- `apply-happy-path-1k.test.ts` — SC#1 (1k records, count audit, lock cycle, v1+v2 coexist, RUN-09 summary)
- `apply-batch.test.ts` + `guarded-write-at-boundary.test.ts` — SC#2 (continuous lock, guarded blocking through boundary)
- `apply-sequence-enforcement.test.ts` — SC#3 (sequence rejection + zero-pending no-op)
- `release-clear.test.ts` + `finalize.test.ts` + `guarded-read-during-finalize.test.ts` — SC#4 (release, finalize, app traffic unaffected)
- `status.ts` and `history.ts` unit tests already pass statically — SC#5 verified by code inspection
**Why human:** DDB Local must be running; test suite cannot be exercised by static analysis

#### 2. RUN-09 Summary Output Confirmation

**Test:** Within the `apply-happy-path-1k.test.ts` run, observe the `stderrSpy` assertion at line 142: `expect(stderrText).toContain('Run \`electrodb-migrations release\` after deploying the new code')`
**Expected:** Assertion passes — the literal string is present in the concatenated stderr output from `renderApplySummary`
**Why human:** Process.stderr.write spy only works in an actual test runner process; the exact string must be observed at runtime

### Gaps Summary

No BLOCKER-class gaps were identified. All five success criteria are VERIFIED by code tracing and integration test structure.

**Warnings requiring awareness before production use:**

1. **BL-01 (double-write):** `applyFlowScanWrite` writes the `_migrations` row twice — first via `upsert` (fingerprint=`'applied:<id>'`) then via `put` (fingerprint=`''`). The second write wins. Net effect: `fingerprint` is `''` post-apply rather than the documented placeholder. Phase 7's `validate` gate writes the real SHA-256 fingerprint. The `itemCounts`, `status='applied'`, and `appliedAt` fields are set correctly by `transitionToReleaseMode`. This is a correctness/documentation bug but does not break any SC. **Fix in Phase 7 or sooner (remove the redundant upsert).**

2. **BL-02 (apply with already-applied migrationId):** When `--migration <id>` is passed but the named migration has already been applied (excluded from pending list), `applyBatch` returns `{applied:[]}` and the CLI prints "No migrations to apply." silently. The operator has no signal that their explicit target was ignored. Not a SC failure (SC#3 covers sequence enforcement, not already-applied detection) but data-loss adjacent as documented in the code review.

3. **BL-04 (finalize --all silent skip):** `client.finalize({all:true})` silently `continue`s when a migration's source file is missing. FIN-02 requires "finalize every applied migration" — silent skip leaves the table in a half-finalized state without operator action, violating the core safety contract. Only affects the error path (missing source files). Happy path verified by unit test CMC-6.

4. **WR-09 (scan without ConsistentRead):** `scan-pipeline.ts` does not pass `consistent: true`. DDB Local is strongly consistent so all integration tests pass. On real AWS, a record visible during the `acquireLock → acquireWaitMs sleep → scan` window could be skipped from migration.

---

_Verified: 2026-05-08T22:11:44Z_
_Verifier: Claude (gsd-verifier)_
