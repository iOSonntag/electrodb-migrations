# Roadmap: electrodb-migrations

## Overview

The journey is from a clean repository to a published npm package `electrodb-migrations@0.1.0` that the author can dogfood on their own production tables. The architecture's eight-tier dependency graph drives the ordering: errors and primitives first, then the file-system authoring loop and DDB I/O foundation in parallel, then the apply/finalize runner converging both, then rollback, cross-entity reads, validate, the test harness, remote execution, and finally distribution. Three DATA-LOSS pitfalls (`ConsistentRead: true` on guard reads, drift fingerprint projection, BatchWriteItem retry-with-count-audit) and one SAFETY-CRITICAL pitfall (heartbeat as self-rescheduling `setTimeout`) are seeded as named primitives in Phase 1 and consumed by every subsequent phase, so the safety invariants are codified in one place rather than re-discovered ten times.

The user picked `granularity: fine` and `parallelization: true`. Phases 2 and 3 are independent (file-system track vs DDB I/O track) and can execute in parallel after Phase 1 lands. Phases 5, 6, and 7 are also largely independent of each other once Phase 4 ships and can be reordered or parallelized.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation & Safety Primitives** - Package skeleton + errors + config + snapshot store + the four load-bearing safety primitives (ConsistentRead constants, fingerprint projection module, BatchWriteItem retry helper, self-rescheduling heartbeat scheduler) ✓ completed 2026-05-03 (151/151 tests, build green)
- [x] **Phase 2: Drift Detection & Authoring Loop** - File-system-only CLI: `init`, `baseline`, `create` (with `v1.ts`/`v2.ts` emission, `model.version` bump, schema diff), drift kinds, scaffold templates, CLI plumbing (commander, picocolors, yocto-spinner, cli-table3, jiti) ✓ completed 2026-05-03 (395/395 tests, build green, CLI smokes)
- [x] **Phase 3: Internal Entities, Lock & Guard** - DDB I/O moat: three internal entities with the five field additions, `Service` wrapper, lock acquire/heartbeat/takeover/transition, guard wrapper with `ConsistentRead: true` + fail-closed + per-process cache + eventual-consistency mock ✓ completed 2026-05-08 (602/602 unit + 45/45 integration tests, BLD-04 cornerstone proven, all 4 BLOCKER review findings resolved)
- [x] **Phase 4: Apply, Release & Finalize Runner** - Happy-path runner: scan v1 records, run `up()`, write v2, transition to release-mode, multi-migration handoff, finalize under maintenance-mode lock; CLI commands `apply`/`release`/`finalize`/`status`/`history` plus blocking programmatic client ✓ completed 2026-05-09 (16/16 plans, 763/763 unit + 60/62 integration tests; BL-01 audit-row regression pinned by 04-15; 2 pre-existing integration failures tracked as DI-04-15-01/02)
- [x] **Phase 5: Rollback Strategies** - Head-only rollback for Cases 1/2/3, four strategies (`projected`/`snapshot`/`fill-only`/`custom`), `rollbackResolver`, refusal cases with reason codes, single-table-design type-table classification using ElectroDB identity stamps, `unlock` command ✓ completed 2026-05-09 (11/11 plans, 957/957 unit + 41/41 Phase-5 integration tests; 2 pre-existing failures DI-04-15-01/02 from Phase 4 unchanged)
- [ ] **Phase 6: Cross-Entity Reads** - `ctx.entity(Other)` read-only proxy, `EDBStaleEntityReadError`, `EDBSelfReadInMigrationError`, `reads` declaration on `defineMigration`, persisted to `_migrations.reads`
- [ ] **Phase 7: Validate, Regenerate & Acknowledge-Removal** - CI gate `validate` with eight rules, `create --regenerate` for parallel-branch resolution, `acknowledge-removal` for entity retirement, frozen-snapshot integrity hashing
- [ ] **Phase 8: Test Harness** - `electrodb-migrations/testing` sub-path: `testMigration` (forward, round-trip, schema-only cases), `testRollbackResolver` (kind A/B/C cases), schema-validated outputs, framework-agnostic, `tsup` testing-entry build
- [ ] **Phase 9: Remote Execution** - `createLambdaMigrationHandler`, HTTPS wire contract, `--remote` CLI flag with CLI-tier loop, `runInBackground`/`getRunStatus`, T-1min watchdog, pre-flight Scan COUNT estimate, sync vs async error shape split
- [ ] **Phase 10: Build, Quality & v0.1.0 Release** - Final `tsup` configuration, `exports` condition ordering verified, `dist/index.js` ts-morph-free verified, dual-package smoke test against fresh consumer project, README accuracy audit, manual `npm publish` dry-run + v0.1.0 release

## Phase Details

### Phase 1: Foundation & Safety Primitives
**Goal**: Package skeleton, error class hierarchy, config loader with invariant validation, snapshot storage, and the four load-bearing safety primitives are in place as named, tested, documented modules that every later phase imports.
**Depends on**: Nothing (first phase)
**Requirements**: FND-02, FND-05, FND-06, ERR-01, ERR-02, ERR-03, ERR-04, ERR-05, ERR-06, ERR-07, ERR-08, CFG-01, CFG-02, CFG-03, CFG-04, CFG-05, CFG-06, CFG-07, CFG-08, CFG-09, CFG-11, SNP-01, SNP-02, SNP-04, DRF-01, DRF-02, DRF-03, DRF-04
**Success Criteria** (what must be TRUE):
  1. Running `pnpm typecheck` against `src/index.ts` exits zero with the eight `EDB*` error classes plus `EDBMigrationError` base re-exported, each carrying a stable `code` string and a duck-typed `is*(err)` checker (no `instanceof` paths).
  2. `defineConfig({...})` returns a typed `ResolvedConfig`; loading a config file with `guard.cacheTtlMs >= lock.acquireWaitMs` throws at startup with a message naming both values and the headroom requirement (per Pitfall #2).
  3. The fingerprint projection module hashes two ElectroDB entities with the same shape but different validators/getters/sparse-index conditions to the same SHA-256 digest, and two entities with one renamed attribute to different digests; `model.version`, deconstructor closures, translations, and lookup tables are excluded.
  4. The `withBatchWriteRetry({write, items})` helper retries `UnprocessedItems` with exponential backoff + full jitter (max 5 attempts, max 30s delay) and surfaces a thrown error with `scanned`/`written`/`unprocessed` counts when retries are exhausted.
  5. `startHeartbeatScheduler({intervalMs, work})` returns a stop handle; the scheduler uses a self-rescheduling `setTimeout` chain (verified by source inspection, never `setInterval`) and stops cleanly even when `work()` rejects.
**Plans**: 9 plans across 5 waves
  - Wave 0: 01-01-PLAN.md — Manifest deltas (engines, peers, jiti, ts-morph, commander 14) + FND-05/FND-06 test scaffolds
  - Wave 1: 01-02-PLAN.md — Error class hierarchy (codes, base, classes, checkers, barrel) — ERR-01..08
  - Wave 1: 01-05-PLAN.md — Config types + defineConfig factory + defaults — CFG-01, CFG-05..09
  - Wave 2: 01-03-PLAN.md — Snapshot canonical serializer + version gate + shared types — SNP-04
  - Wave 2: 01-04-PLAN.md — Three runtime safety primitives (consistent-read, heartbeat-scheduler, batch-write-retry)
  - Wave 2: 01-06-PLAN.md — Config invariants + jiti loader + merge + barrel — CFG-02, CFG-03, CFG-04, CFG-11
  - Wave 3: 01-07-PLAN.md — Snapshot paths + reader + writer + barrel — SNP-01, SNP-02
  - Wave 3: 01-08-PLAN.md — Fingerprint projection allowlist + drift wrapper — DRF-01..04
  - Wave 4: 01-09-PLAN.md — Public surface src/index.ts + build verification — FND-02 + FND-06 active enforcement

### Phase 2: Drift Detection & Authoring Loop
**Goal**: A user can edit an entity, run `npx electrodb-migrations create --entity X --name Y`, and get a migration folder with frozen `v1.ts`/`v2.ts`, a `migration.ts` stub, an automatic `model.version` bump in their entity source, and a printed schema diff — entirely without DDB.
**Depends on**: Phase 1
**Requirements**: FND-04, DRF-05, DRF-06, DRF-07, INI-01, INI-02, INI-03, SCF-01, SCF-02, SCF-03, SCF-04, SCF-05, SCF-06, SCF-07, SNP-03, CLI-01, CLI-08, CLI-09, CFG-10
**Success Criteria** (what must be TRUE):
  1. `npx electrodb-migrations init` in an empty directory creates `.electrodb-migrations/`, `src/database/migrations/`, and `electrodb-migrations.config.ts` with sensible defaults; re-running without `--force` errors with a helpful message; `--force` overwrites.
  2. `npx electrodb-migrations baseline` against a project with three pre-existing ElectroDB entities writes three snapshot files plus a `_journal.json` index without scaffolding any migration; running `baseline` a second time is a no-op.
  3. After editing an entity to add a required `status` attribute, `npx electrodb-migrations create --entity User --name add-status` prints a colored diff `+ status: 'active' | 'inactive' (required) ⚠ NEEDS DEFAULT IN up()`, writes `migrations/<timestamp>-User-add-status/{v1.ts,v2.ts,migration.ts}`, bumps `model.version: '1' → '2'` in the user's entity file (preserving comments and formatting via ts-morph), and updates the framework's snapshot.
  4. `create --entity User --name behavior-tweak` against an entity with no shape drift exits with "no drift detected" and a non-zero status; `create --force` produces a migration anyway.
  5. The drift detector classifies all eight kinds (`attribute-added`, `attribute-removed`, `attribute-changed`, `index-added`, `index-removed`, `index-changed`, `key-rename`, `entity-removed`) on fixture entities, and the unit-test matrix passes against ElectroDB 3.0, 3.5, and the latest 3.x.
**Plans**: 9 plans across 4 waves
  - Wave 0: 02-01-PLAN.md — Manifest deltas (picocolors/yocto-spinner/cli-table3) + snapshot v1->v2 + defineMigration on public surface + ts-morph allowlist pre-wire
  - Wave 1: 02-02-PLAN.md — Drift classifier (8 kinds) + diff renderer with injected colorizer — DRF-05, DRF-06, SCF-06
  - Wave 1: 02-03-PLAN.md — Frozen-snapshot generator + integrity-hash + migration-id (clock-injected) — SCF-02
  - Wave 1: 02-04-PLAN.md — ts-morph entity-version bumper + 9-fixture style matrix — SCF-04
  - Wave 1: 02-05-PLAN.md — CLI program + output utilities (colors/log/spinner/table/exit-codes) + bin entry — CLI-01, CLI-08, CLI-09
  - Wave 2: 02-06-PLAN.md — Cross-version stability (Path B synthetic projections for 3.0/3.5/3.7) — DRF-07
  - Wave 2: 02-07-PLAN.md — Scaffold orchestrator + migration.ts template + 12-step transactional flow — SCF-03, SCF-05, SCF-07, SNP-03
  - Wave 2: 02-08-PLAN.md — user-entities tier (discover/load/inspect) + init + baseline commands — INI-01, INI-02, INI-03
  - Wave 3: 02-09-PLAN.md — create command end-to-end (FND-06 lazy chain wiring) — SCF-01

### Phase 3: Internal Entities, Lock & Guard
**Goal**: The framework can acquire a distributed lock on the user's table, hold it with heartbeats that survive Lambda freeze/thaw, transition through the three-mode state machine, and gate app traffic via a guard-wrapped DDB client that fails closed when the lock row read fails.
**Depends on**: Phase 1 (parallel with Phase 2 — independent of it)
**Requirements**: ENT-01, ENT-02, ENT-03, ENT-04, ENT-05, ENT-06, LCK-01, LCK-02, LCK-03, LCK-04, LCK-05, LCK-06, LCK-07, LCK-08, LCK-09, LCK-10, GRD-01, GRD-02, GRD-03, GRD-04, GRD-05, GRD-06, GRD-07, BLD-04
**Success Criteria** (what must be TRUE):
  1. Acquiring a lock from a single test runner against DynamoDB Local writes a `_migration_state` row with `lockState='apply'`, `lockHolder`, `lockRunId`, `lockAcquiredAt`, and `heartbeatAt`; a second concurrent acquire rejects with `EDBMigrationLockHeldError` (conditional-write check fails).
  2. Every `GetItem` call against `_migration_state` from `lock/` and `guard/` uses `ConsistentRead: true` (verified by a source-scan test that fails if any `GetItem` in those modules omits the flag); a vitest harness simulates an eventual-consistency window and confirms the guard never returns `lockState='free'` during the runner's pre-write wait.
  3. Heartbeat refresh runs as a self-rescheduling `setTimeout` chain at `lock.heartbeatMs` cadence; a test that pauses the event loop for `2 * heartbeatMs` and resumes shows exactly one heartbeat write fires (not a queued burst), and after two consecutive failed heartbeat writes the runner aborts and marks the migration `failed`.
  4. Stale-takeover only fires for active states (`apply`, `finalize`, `rollback`, `dying`); a `release` or `failed` lock with `heartbeatAt` older than `staleThresholdMs` cannot be taken over and must be cleared via `unlock`.
  5. A guarded DocumentClient and a guarded raw DynamoDBClient both intercept `GetCommand`, `PutCommand`, `UpdateCommand`, `DeleteCommand`, `BatchWriteCommand`, `TransactWriteCommand`, and `QueryCommand`; when `lockState ∈ {apply, finalize, rollback, release, failed, dying}` they throw `EDBMigrationInProgressError` with `details.{runId, lockState}`; with `blockMode: 'writes-only'` reads pass through but writes still throw; a thrown error from the lock-row `GetItem` causes the guard to fail closed (throw `EDBMigrationInProgressError`).
**Plans**: 8 plans across 5 waves
  - Wave 0: 03-01-PLAN.md — Manifest deltas (DDB Local lifecycle helpers, eventual-consistency simulator, source-scan/fake-clock/concurrent-acquire helpers, ElectroDB where()-operator spike, A7 finalize-gating decision recorded) — BLD-04
  - Wave 1: 03-02-PLAN.md — Internal entities move (src/entities/ → src/internal-entities/) + 5 field deltas (`dying` enum, reads/rollbackStrategy/hasDown/hasRollbackResolver, lastHeartbeatAt) + unit tests — ENT-01..06
  - Wave 1: 03-03-PLAN.md — State-mutations layer (acquire/heartbeat/transition/clear/mark-failed/append-in-flight/unlock + cancellation helpers) + unit tests — LCK-05, LCK-09
  - Wave 2: 03-04-PLAN.md — Lock subsystem orchestrators (acquireLock + read-back verify, startLockHeartbeat ≤25-line wrapper, forceUnlock, staleCutoffIso, readLockRow) + source-scan invariants — LCK-01, LCK-02, LCK-03, LCK-04, LCK-07, LCK-08, LCK-10
  - Wave 3: 03-05-PLAN.md — Guard subsystem (cache, classify, lock-state-set per Decision A7, wrapClient via AWS SDK middleware) + extend source-scan to src/guard/ — GRD-01..07
  - Wave 4: 03-06-PLAN.md — Lock + Service integration tests (acquire-race, stale-takeover, heartbeat-survives-pause, finalize-mode, unlock truth-table, multi-migration batch, ENT-06 transactWrite) — LCK-06
  - Wave 4: 03-07-PLAN.md — Guard + BLD-04 integration tests (intercept-all-commands, eventual-consistency cornerstone, cache-ttl, fail-closed, block-mode)
  - Wave 4: 03-08-PLAN.md — LCK-04 seam tripwire + Decision A7 source-scan + 24/24 requirement coverage audit — LCK-04

### Phase 4: Apply, Release & Finalize Runner
**Goal**: Pending migrations apply end-to-end against a real DynamoDB Local table: scan v1 records, run user `up()`, write v2 records (with the count-audit invariant enforced), transition to release-mode, hand off internally for multi-migration batches, clear with `release`, and finalize under maintenance-mode lock.
**Depends on**: Phases 2 and 3
**Requirements**: RUN-01, RUN-02, RUN-03, RUN-04, RUN-05, RUN-06, RUN-07, RUN-08, RUN-09, REL-01, REL-02, FIN-01, FIN-02, FIN-03, FIN-04, CLI-03, CLI-04, API-01, API-02, API-06
**Success Criteria** (what must be TRUE):
  1. Against a DynamoDB Local table seeded with 1,000 v1 User records, `npx electrodb-migrations apply` transitions the lock through `free → apply → release`, writes 1,000 v2 records alongside the v1 records (verified by ElectroDB v1 query returning 1,000 hits and v2 query also returning 1,000), and prints a success summary that includes the count audit (`scanned == migrated + skipped + failed`) and a numbered checklist with "Run `release` after deploying code" prominent.
  2. Two pending migrations applied in sequence transition through one continuous lock cycle (`apply` → release-mode → `apply` → release-mode → final release pending) without an intervening manual `release`; app traffic stays gated continuously per the guarded-client check.
  3. `npx electrodb-migrations apply --migration <id>` for an id that is not the next pending sequence position rejects with a friendly error naming the actual next id; `apply` with no pending migrations exits zero with "no migrations to apply".
  4. `npx electrodb-migrations release` clears the release-mode lock when no `inFlightIds` remain; running it again is a friendly idempotent no-op; `npx electrodb-migrations finalize <id>` deletes all v1 records under maintenance-mode lock (app traffic unaffected, verified by guarded read going through), marks the migration `finalized`, and clears the lock.
  5. `npx electrodb-migrations status` prints the current `lockState`, `lockHolder`, `lockRunId`, `heartbeatAt`, and per-migration progress in a `cli-table3` table; `npx electrodb-migrations history --json` emits the full `_migrations` log as machine-readable JSON suitable for piping to `jq`.
**Plans**: 16 plans across 5 waves (complete — see `.planning/phases/04-apply-release-finalize-runner/`)

### Phase 5: Rollback Strategies
**Goal**: A user can run `npx electrodb-migrations rollback <id>` against the head migration and recover from any of the three lifecycle cases, choosing among four strategies (`projected`, `snapshot`, `fill-only`, `custom`) with explicit refusal cases when a strategy is impossible — and recover from a stuck lock via `unlock`.
**Depends on**: Phase 4
**Requirements**: RBK-01, RBK-02, RBK-03, RBK-04, RBK-05, RBK-06, RBK-07, RBK-08, RBK-09, RBK-10, RBK-11, RBK-12, CLI-05, CLI-06, CLI-07, API-05
**Success Criteria** (what must be TRUE):
  1. Pre-release rollback (`rollback <id>` while lock is in release mode after a failed or unreleased apply) deletes every v2 record without invoking `down()`; v1 records remain intact; `down`-less migrations succeed.
  2. Post-release rollback with `--strategy projected` (default) on a single-table-design fixture (User and Team sharing a PK prefix) classifies records into types A/B/C/D using frozen ElectroDB v1/v2 identity stamps (not raw `(pk, sk)`), runs `down(v2)` for types A and B, and deletes the v1 mirror for type C; the type-table counts match a hand-computed expected matrix.
  3. Post-release rollback with `--strategy snapshot` prints the explicit type-B and type-C counts and prompts for confirmation before proceeding; `--strategy fill-only` runs `down(v2)` only for type B and leaves originals for A and C; `--strategy custom` invokes the user-supplied `rollbackResolver` per record with `{kind, v1Original, v2, down}` and respects `null` returns as deletes.
  4. Post-finalize rollback with `--strategy snapshot` or `--strategy fill-only` rejects with `EDBRollbackNotPossibleError({reason: 'FINALIZED_ONLY_PROJECTED'})`; rollback of a non-head migration rejects with `EDBRollbackOutOfOrderError` naming the offending later migration; `--strategy projected` without `down` defined rejects with `EDBRollbackNotPossibleError({reason: 'NO_DOWN_FUNCTION'})`; `--strategy custom` without `rollbackResolver` rejects with `EDBRollbackNotPossibleError({reason: 'NO_RESOLVER'})`.
  5. `npx electrodb-migrations unlock --run-id <runId>` requires `--run-id` even with `--yes`; the interactive prompt shows `lockState`, `lockHolder`, `lockRunId`, `heartbeatAt`, and elapsed runtime before confirmation; clearing a `lockState='apply'` lock marks the migration `failed`, clearing a `lockState='release'` lock is equivalent to `release`, and clearing a `lockState='finalize'` lock marks the finalize `failed`.
**Plans**: 11 plans across 5 waves
  - [x] 05-01-PLAN.md — Wave 0: test-infrastructure (4 fixture migrations, 2 seed helpers, integration bootstrap, unit stub, EDBRollbackCountMismatchError, source-scan glob extension to src/rollback/) — RBK-12
  - [x] 05-02-PLAN.md — Wave 1: preconditions + lifecycle-case + head-only (TDD; refusal truth-table dispatch) — RBK-01, RBK-09, RBK-10
  - [x] 05-03-PLAN.md — Wave 1: identity-stamp utilities + type-table classifier + STD safety integration test (TDD) — RBK-04, RBK-11
  - [x] 05-04-PLAN.md — Wave 1: rollback audit + resolver-validate + heterogeneous batch-flush (TDD; the plumbing layer) — RBK-08 (partial), RBK-12
  - [x] 05-05-PLAN.md — Wave 2: strategy executors projected + fill-only (TDD; both require down) — RBK-05, RBK-07
  - [x] 05-06-PLAN.md — Wave 2: strategy executor snapshot + DATA-LOSS warning (TDD; B/C count prompt; --yes audit trail) — RBK-06
  - [x] 05-07-PLAN.md — Wave 2: strategy executor custom + rollbackResolver type tightening (TDD; per-record resolver dispatch; Pitfall 3 schema-validation) — RBK-08
  - [x] 05-08-PLAN.md — Wave 2: case-1 flow (TDD; pre-release v2-deletion path; lossless; no down required) — RBK-03
  - [x] 05-09-PLAN.md — Wave 3: rollback orchestrator (lock-cycle wrapper + dispatch) + 7 integration tests (lock-cycle, case-1, projected, snapshot, fill-only, custom, audit-row-shape) — RBK-02, RBK-03..12
  - [x] 05-10-PLAN.md — Wave 3: MigrationsClient API surface (rollback, forceUnlock, getLockState, getGuardState) + integration tests — API-05
  - [x] 05-11-PLAN.md — Wave 4: CLI commands rollback + unlock (commander wiring + cli-table3 prompt + readline confirm) — CLI-05, CLI-06, CLI-07

### Phase 6: Cross-Entity Reads
**Goal**: A migration's `up()` and `down()` can read related entities through a runner-injected `ctx.entity(Other)` proxy that is bound to the unguarded client, enforces read-only access, blocks self-reads, and validates on-disk shape against the imported source before issuing the read.
**Depends on**: Phase 4
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07, CTX-08
**Success Criteria** (what must be TRUE):
  1. Inside a User migration's `up(user, ctx)`, `await ctx.entity(Team).get({id: user.teamId}).go()` returns the Team record using the runner's unguarded client (verified by the call succeeding while the lock is held in `apply` state, which would otherwise throw `EDBMigrationInProgressError` through the guard).
  2. Calling any write method (`put`, `update`, `delete`, `patch`, `create`, `batchWrite`) on the proxy throws a clear "reads-only" error before hitting DDB.
  3. `ctx.entity(SelfEntity)` from inside its own migration throws `EDBSelfReadInMigrationError` before any DDB call; calling `ctx.entity(Y)` when on-disk Y's snapshot fingerprint does not match the imported Y throws `EDBStaleEntityReadError` with the conflicting migration named in `details`.
  4. `defineMigration({reads: [Team, Org]})` persists the entity-name set on `_migrations.reads` at apply time; re-loading the migration row from the audit log surfaces the same set without re-importing the migration source.
  5. The CTX integration tests cover the four declared/undeclared × in-bounds/out-of-bounds combinations and all pass against DynamoDB Local in under 30 seconds.
**Plans**: 6 plans across 6 waves
  - [x] 06-01-PLAN.md — Wave 0: spike test (entity-clone via `new Entity(schema, config)`) + 2 fixtures (User-reads-Team, User-self-read) + RED tests for CTX-01..06 + CTX-08 + ctx source-scan invariant (no `setClient` in src/ctx/) — gates Wave 1 until spike passes
  - [x] 06-02-PLAN.md — Wave 1: src/ctx/types.ts (MigrationCtx + ReadOnlyEntityFacade<E>) + src/ctx/read-only-facade.ts (createReadOnlyFacade with 6 read methods + 7 write traps) — CTX-02, CTX-03
  - [x] 06-03-PLAN.md — Wave 2: src/ctx/build-ctx.ts (eager-for-declared + lazy-for-undeclared validation) + src/ctx/index.ts barrel + apply-flow + apply-batch + client.apply cwd plumbing — CTX-01, CTX-04, CTX-05, CTX-06
  - [x] 06-04-PLAN.md — Wave 3: rollback orchestrator + strategy executors retrofitted to thread ctx through migration.down(record, ctx) per RESEARCH §A6 + RollbackArgs.cwd + client.rollback wiring — CTX-01 (down-side)
  - [x] 06-05-PLAN.md — Wave 4: ROLLBACK_REASON_CODES.READS_DEPENDENCY_APPLIED + checkPreconditions Step 10 (CTX-08) using fromVersion comparison (clock-skew safe per RESEARCH §A3) — CTX-08
  - [x] 06-06-PLAN.md — Wave 5: setupCtxTestTable helper + SC-5 four-cell matrix integration test (ctx-read.test.ts) + CTX-06 audit-row test + CTX-08 rollback-refusal integration test + README §6.6 update — integration coverage for all 5 phase SCs

### Phase 7: Validate, Regenerate & Acknowledge-Removal
**Goal**: A team can run `npx electrodb-migrations validate` in CI as a pre-merge gate that catches drift-without-migration, version skew, sequence gaps, parallel-branch collisions, cross-entity ordering violations, removed entities, reserved-namespace user entities, and edited-frozen-schema files; users can resolve parallel-branch conflicts via `create --regenerate` and retire entities via `acknowledge-removal`.
**Depends on**: Phase 6 (cross-entity ordering rule needs Phase 6's `reads` declaration; other rules only need Phase 2)
**Requirements**: SCF-08, VAL-01, VAL-02, VAL-03, VAL-04, VAL-05, VAL-06, VAL-07, VAL-08, VAL-09, VAL-10, CLI-02
**Success Criteria** (what must be TRUE):
  1. `npx electrodb-migrations validate` against a clean repository exits zero in under one second with no DDB calls (pure file-system + entity-import logic only).
  2. Eight rule violations each surface as distinct, readable error messages naming the offending file(s) and pointing at the appropriate fix: `drift-without-migration` → "run `create`", `version-skew` → diff between entity `model.version` and latest scaffolded `toVersion`, `sequence-gaps` → list of missing version numbers respecting `migrationStartVersions`, `parallel-branch-collision` → both colliding migration ids and "run `create --regenerate`", `cross-entity-ordering` → both migration ids and the conflicting `reads` target, `removed-entities` → list of removed entities and "run `acknowledge-removal`", `reserved-namespace` → user entity name starting with `_`, `frozen-snapshot-edited` → integrity hash mismatch on `v1.ts` or `v2.ts`.
  3. After branch B is rebased on a main that landed branch A's User migration, `npx electrodb-migrations create --regenerate <id>` rewrites `v1.ts` and `v2.ts` to the new "previous" shape and the current entity, preserves the user's `up()`/`down()` code byte-for-byte, advances the migration's `from`/`to` versions, and prints the new schema diff.
  4. `npx electrodb-migrations acknowledge-removal User` advances the framework's snapshot to record User as intentionally removed, does not touch any DDB records, and a subsequent `validate` exits zero.
  5. Frozen `v1.ts`/`v2.ts` files are integrity-hashed at scaffold time (hash stored alongside the snapshot) and `validate` re-checks each hash; manually editing either file flips the corresponding rule to `frozen-snapshot-edited` failure.
**Plans**: TBD

### Phase 8: Test Harness
**Goal**: Users can write framework-agnostic unit tests for migrations under `electrodb-migrations/testing` that exercise `up()`, `down()`, and `rollbackResolver` with type inference from `migration.from`/`migration.to`, schema-validated outputs, and three case shapes — published as a separate sub-path export with correct `tsup` build wiring.
**Depends on**: Phase 5 (testRollbackResolver needs the rollbackResolver type) and Phase 1 (tsup library config)
**Requirements**: FND-03, TST-01, TST-02, TST-03, TST-04, TST-05, TST-06, TST-07, BLD-01, BLD-02
**Success Criteria** (what must be TRUE):
  1. `pnpm build` produces `dist/testing.js`, `dist/testing.cjs`, `dist/testing.d.ts`, and `dist/testing.d.cts`; `package.json` `exports['./testing']` block has `types` first followed by `import` and `require`; `pnpm exec attw --pack .` (Are The Types Wrong) reports zero issues for both `.` and `./testing` subpaths.
  2. From a fresh consumer project, `import { testMigration, testRollbackResolver } from 'electrodb-migrations/testing'` resolves under both ESM and CJS, and `testMigration` autocompletes the `input` and `expectedV2` fields against the migration's `from` and `to` types.
  3. `testMigration(migration, [{input, expectedV2}])` deep-equals `up(input)` against `expectedV2` AND validates the result against v2's ElectroDB schema; a transform that produces the right keys but a wrong type fails the schema check even when the user did not assert that field.
  4. `testMigration(migration, [{roundTrip}])` asserts `down(up(x))` deep-equals `x`; if `down` is undefined the harness throws "round-trip case requires `down` on the migration"; `testMigration(migration, [{input, expectedV2: 'valid'}])` validates `up(input)` against v2's schema without specifying exact values (for non-deterministic transforms).
  5. `testRollbackResolver(migration, cases)` accepts kind A/B/C cases with `{v1Original?, v2?, expected}` shape; the harness throws on the first failure and returns normally on success; the README's vitest-wrapping pattern (`describe('migration', () => { it('passes', () => testMigration(...)) })`) works without importing vitest from the harness.
**Plans**: TBD

### Phase 9: Remote Execution
**Goal**: Large-table migrations execute on AWS Lambda (or any HTTPS endpoint) through `--remote`, with the CLI orchestrating one wire call per migration, the Lambda handler running the same runner as local CLI, the watchdog at T-1min writing a clean failure marker if the migration won't complete in time, and pre-flight Scan COUNT estimates warning operators about Lambda timeouts.
**Depends on**: Phase 4 (runner) and Phase 5 (rollback) and Phase 7 (validate)
**Requirements**: RMT-01, RMT-02, RMT-03, RMT-04, RMT-05, RMT-06, RMT-07, RMT-08, RMT-09, API-03, API-04
**Success Criteria** (what must be TRUE):
  1. `createLambdaMigrationHandler({config, client, tableName, apiKey, migrations})` returns a handler that validates the `X-Api-Key` header, switches on the wire-contract `command`, routes async commands (`apply`, `rollback`, `finalize`) to `runInBackground` returning `{runId, status: 'started'}` synchronously, and routes sync commands (`release`, `status`, `history`, `unlock`) to their inline result.
  2. `npx electrodb-migrations apply --remote` resolves the pending migration list locally, then issues one POST per pending migration with a polling loop on `getRunStatus(runId)` between calls; the wire never carries `--all` as a single call; each POST gets the full Lambda timeout budget.
  3. The Lambda watchdog wakes at T-(remaining=1min) and, if the migration is still running, writes a clean failure marker on `_migration_runs` (status `failed`, error code `EDB_LAMBDA_TIMEOUT_APPROACHING`) so the next polling read surfaces a meaningful error rather than a torn lock.
  4. `apply --remote` with a pending migration whose pre-flight `Scan COUNT` estimate exceeds Lambda timeout × estimated-records-per-second prints a warning to stderr (not stdout) and asks for confirmation before issuing the POST; `--yes` skips the prompt.
  5. Start errors (lock held, no migrations, validation) return the synchronous error shape `{error: {code, message, details}}` from the wire endpoint without issuing a `runId`; run errors (failures during execution) surface on `getRunStatus(runId)` as `{status: 'failed', error: {code, message, details}}` with `lastHeartbeatAt` populated from the final completed run row.
**Plans**: TBD

### Phase 10: Build, Quality & v0.1.0 Release
**Goal**: The package is buildable, typecheck-clean, lint-clean, integration-test-green, the `dist/` artifacts are correct (no `ts-morph` in the library bundle, dual ESM+CJS, types-first exports), README accuracy is verified end-to-end, and `electrodb-migrations@0.1.0` is published to npm under the user's credentials.
**Depends on**: Phase 9 (full feature surface needed before release)
**Requirements**: FND-01, BLD-03, BLD-05, BLD-06, BLD-07, DST-01, DST-02, DST-03, DST-04
**Success Criteria** (what must be TRUE):
  1. `pnpm typecheck` (runs `tsc --noEmit`) and `pnpm check` (runs `biome check`) both exit zero across the full `src/` tree; `pnpm test` runs the full vitest unit suite green; `pnpm test:integration` runs the integration suite against `docker compose up -d dynamodb-local` green.
  2. `pnpm build` followed by `node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"` lists every public export documented in the README (createMigrationsClient, createLambdaMigrationHandler, defineConfig, defineMigration, isMigrationInProgress, the eight EDB error classes, etc.); a separate scan asserts `dist/index.js` does not import `ts-morph` (size assertion AND import-graph scan, both passing).
  3. From a fresh consumer project (`pnpm init` + `pnpm add ./path/to/electrodb-migrations`), `import` and `require` of both `electrodb-migrations` and `electrodb-migrations/testing` succeed under TypeScript's `Bundler` and `NodeNext` module resolution settings, and `tsc --noEmit` against an example consumer file resolves all types.
  4. Every requirement in REQUIREMENTS.md maps to a README section (DST-01); the README accuracy audit checklist is signed off (every `npx` command in the README executes against a fixture project and produces the documented output, modulo timestamps).
  5. `npm publish --dry-run` produces a tarball containing only `dist/`, `package.json`, `README.md`, `LICENSE` (per `files` field) — no `src/`, no tests, no `.planning`, no `.research`; the resulting `electrodb-migrations@0.1.0` is then published with `npm publish` under the user's credentials and a tagged release exists in npm registry.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Phase 2 and Phase 3 are independent and may execute in parallel after Phase 1; Phases 5/6/7 are largely independent of each other after Phase 4.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Safety Primitives | 9/9 | Complete | 2026-05-03 |
| 2. Drift Detection & Authoring Loop | 9/9 | Complete | 2026-05-03 |
| 3. Internal Entities, Lock & Guard | 8/8 | Complete | 2026-05-08 |
| 4. Apply, Release & Finalize Runner | 16/16 | Complete | 2026-05-09 |
| 5. Rollback Strategies | 11/11 | Complete | 2026-05-09 |
| 6. Cross-Entity Reads | 0/TBD | Not started | - |
| 7. Validate, Regenerate & Acknowledge-Removal | 0/TBD | Not started | - |
| 8. Test Harness | 0/TBD | Not started | - |
| 9. Remote Execution | 0/TBD | Not started | - |
| 10. Build, Quality & v0.1.0 Release | 0/TBD | Not started | - |
