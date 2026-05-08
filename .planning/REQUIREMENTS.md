# Requirements: electrodb-migrations

**Defined:** 2026-05-02
**Core Value:** A migration on a live ElectroDB/DynamoDB table cannot silently corrupt data.

## v1 Requirements

Requirements for the v0.1 npm release. The README is the documentation contract — every requirement here corresponds to a section of `README.md`. Categories follow the synthesis architecture tiers.

### Foundation

- [ ] **FND-01**: Project ships as a public npm package `electrodb-migrations` (Apache-2.0)
- [ ] **FND-02**: Build emits dual ESM (`dist/index.js`) and CJS (`dist/index.cjs`) artifacts via `tsup` with TypeScript declaration files
- [ ] **FND-03**: Build emits a separate `./testing` sub-path entry (`dist/testing.{js,cjs,d.ts}`) for the unit-test harness
- [ ] **FND-04**: CLI binary `electrodb-migrations` is registered under `bin` and runs with shebang under Node ≥20
- [ ] **FND-05**: `package.json` `engines.node` floor is `>=20`; `electrodb` peer dep is `>=3.0.0 <4.0.0`; `@aws-sdk/client-dynamodb` peer dep is `>=3.0.0`
- [ ] **FND-06**: `ts-morph` is lazy-loaded only by the `create` command; `dist/index.js` does not include it (verified by build size check)

### Errors

- [ ] **ERR-01**: `EDBMigrationError` base class with `code`, `message`, `details` properties; subclasses share dual-package-safe duck-typed checkers (no `instanceof` in user code)
- [ ] **ERR-02**: `EDBMigrationLockHeldError` thrown when conditional-write lock acquisition fails
- [ ] **ERR-03**: `EDBMigrationInProgressError` thrown by guard wrapper on intercepted DDB calls; `isMigrationInProgress(err)` helper exported
- [ ] **ERR-04**: `EDBRequiresRollbackError` thrown when `failedIds` is non-empty on next `apply`
- [ ] **ERR-05**: `EDBRollbackNotPossibleError` with `reason` codes: `NO_DOWN_FUNCTION`, `NO_RESOLVER`, `FINALIZED_ONLY_PROJECTED`
- [ ] **ERR-06**: `EDBRollbackOutOfOrderError` thrown when rollback target is not the head migration
- [ ] **ERR-07**: `EDBStaleEntityReadError` thrown when `ctx.entity(Y)` finds on-disk shape ≠ imported source
- [ ] **ERR-08**: `EDBSelfReadInMigrationError` thrown when `ctx.entity(X)` is called from inside X's own migration

### Configuration

- [ ] **CFG-01**: `defineConfig(...)` factory accepts `entities`, `migrations`, `region`, `tableName`, `keyNames`, `lock`, `guard`, `remote`, `migrationStartVersions`, `runner` options
- [ ] **CFG-02**: Config file `electrodb-migrations.config.{ts,js,mjs,cjs,json}` is auto-resolved from project root by the CLI
- [ ] **CFG-03**: TypeScript config files load via `jiti` without compilation step; respects user's tsconfig path mappings
- [ ] **CFG-04**: Startup invariant validation refuses to run if `guard.cacheTtlMs >= lock.acquireWaitMs`
- [ ] **CFG-05**: `keyNames` overrides DDB primary-key attribute names (`pk`/`sk` defaults) and the ElectroDB identifier markers; the framework ships no defaults for `electroEntity` / `electroVersion` and forwards `identifiers` to ElectroDB only when the user explicitly supplies them (ElectroDB's own defaults are currently `__edb_e__` / `__edb_v__`)
- [ ] **CFG-06**: `lock` accepts `heartbeatMs` (default 30000), `staleThresholdMs` (default 14400000), `acquireWaitMs` (default 15000)
- [ ] **CFG-07**: `guard` accepts `cacheTtlMs` (default 5000), `blockMode` (`'all'` default, `'writes-only'`)
- [ ] **CFG-08**: `runner.concurrency` config slot reserved with default `1` (no-op in v0.1; reserved for v0.2 batched parallelism)
- [ ] **CFG-09**: `migrationStartVersions` per-entity (e.g. `{ User: { version: 5 } }`) is honored by both `validate` and the migration runner
- [ ] **CFG-10**: `remote` accepts `url` and `apiKey`; `--remote` CLI flag uses these to dispatch to the wire endpoint
- [ ] **CFG-11**: Override precedence: explicit runtime arg > CLI flag > config field > built-in default

### Internal Entities

- [ ] **ENT-01**: `_migration_state` ElectroDB entity (single aggregate row keyed by sentinel id `state`) carries `lockState`, `lockHolder`, `lockRunId`, `lockAcquiredAt`, `lockMigrationId`, `heartbeatAt`, `inFlightIds`, `failedIds`, `releaseIds`, `schemaVersion`, `updatedAt`
- [ ] **ENT-02**: `lockState` enum is `free | apply | finalize | rollback | release | failed | dying` (the `dying` state added in v0.1 schema version 1 to support graceful-exit signaling)
- [ ] **ENT-03**: `_migrations` ElectroDB entity carries `id`, `kind`, `status`, `appliedAt`, `finalizedAt`, `revertedAt`, `appliedBy`, `appliedRunId`, `revertedRunId`, `fromVersion`, `toVersion`, `entityName`, `fingerprint`, `itemCounts`, `error`, `reads`, `rollbackStrategy`, `hasDown`, `hasRollbackResolver`, `schemaVersion`
- [ ] **ENT-04**: `_migration_runs` ElectroDB entity carries `runId`, `command`, `status`, `migrationId`, `startedAt`, `completedAt`, `lastHeartbeatAt`, `startedBy`, `error`, `schemaVersion`
- [ ] **ENT-05**: All three internal entities live in the user's table (single-table-design friendly) with `model.service: '_electrodb_migrations'` and `model.entity: '_*'`; `keyNames` and `identifiers` are forwarded so they coexist with renamed user attributes
- [ ] **ENT-06**: ElectroDB `Service` wraps the three entities for atomic cross-entity `TransactWriteItems` (e.g. flip migration to `applied` + append run record + clear lock in one transaction)

### Snapshot Storage

- [ ] **SNP-01**: `.electrodb-migrations/` directory is the framework-managed state (committed by user); contents are JSON with sorted keys
- [ ] **SNP-02**: One JSON file per entity holding the most recent shape fingerprint and projected schema; `_journal.json` indexes them
- [ ] **SNP-03**: Frozen `v1.ts` and `v2.ts` snapshots in each migration folder are integrity-hashed at scaffold time; `validate` re-checks the hash and refuses if a user manually edited them
- [ ] **SNP-04**: Snapshot file format is versioned (`schemaVersion` field); old-version snapshots are detected with a clear migration-required error

### Drift Detection

- [ ] **DRF-01**: Drift fingerprint hashes a normalized projection of ElectroDB's parsed `entity.model` (NOT raw `JSON.stringify`)
- [ ] **DRF-02**: Projection includes per-attribute `{type, required, hidden, readOnly, field, enumValues, properties?, items?}` and per-index shape (pk/sk composite, type) — explicit allowlist
- [ ] **DRF-03**: Projection excludes closures (`get`, `set`, `validate`, `cast`, `default`, deconstructors), translations, lookup tables, and `model.version`
- [ ] **DRF-04**: All keys in the projection are recursively sorted before hashing for deterministic fingerprints
- [ ] **DRF-05**: Drift kinds detected: `attribute-added`, `attribute-removed`, `attribute-changed`, `index-added`, `index-removed`, `index-changed`, `key-rename`, `entity-removed`
- [ ] **DRF-06**: Behavior-only changes (validators, getters, sparse-index `condition` functions) do NOT trigger drift; `create --force` provides explicit override
- [ ] **DRF-07**: Drift detector runs against ElectroDB 3.0, 3.5, and latest 3.x in CI matrix (verified projection stability across minors)

### Init & Baseline

- [ ] **INI-01**: `electrodb-migrations init` creates `.electrodb-migrations/`, `src/database/migrations/`, and `electrodb-migrations.config.ts` pre-populated with sensible defaults
- [ ] **INI-02**: `init --force` overwrites an existing `electrodb-migrations.config.ts`
- [ ] **INI-03**: `electrodb-migrations baseline` snapshots all current entity shapes into `.electrodb-migrations/` without scaffolding any migration (idempotent for adoption on a live project)

### Scaffolding

- [ ] **SCF-01**: `create --entity <name> --name <slug>` generates `migrations/<timestamp>-<entity>-<slug>/{v1.ts, v2.ts, migration.ts}`
- [ ] **SCF-02**: `v1.ts` is a frozen schema-only copy of the previous shape; `v2.ts` is a frozen schema-only copy of the new shape
- [ ] **SCF-03**: `migration.ts` is a stub with `defineMigration({...})` and a `up()` placeholder
- [ ] **SCF-04**: `create` bumps `model.version` in the user's entity source file (`'1' → '2'`) using `ts-morph`, preserving formatting and comments
- [ ] **SCF-05**: `create` updates the framework's internal snapshot for that entity
- [ ] **SCF-06**: `create` prints a human-readable schema diff summary
- [ ] **SCF-07**: `create --force` scaffolds even when no shape drift is detected (for behavior-only changes that need data work)
- [ ] **SCF-08**: `create --regenerate <id>` re-frames an existing migration onto the new baseline after a rebase, preserving `up()`/`down()` and rewriting `v1.ts`/`v2.ts`

### Lock State Machine

- [ ] **LCK-01**: Lock acquisition uses DDB conditional-write + read-back verify (refuses to proceed if the post-write read shows a different `lockRunId`)
- [ ] **LCK-02**: Heartbeat refresh runs as a self-rescheduling `setTimeout` chain (NEVER `setInterval`) at `lock.heartbeatMs` cadence
- [ ] **LCK-03**: Stale-takeover applies only to active states (`apply`, `finalize`, `rollback`, `dying`); never to `release` or `failed`
- [ ] **LCK-04**: Pre-migration wait window of `lock.acquireWaitMs` is enforced before any transform write (READ: guards have already had time to refresh their cache)
- [ ] **LCK-05**: After successful `apply`/`rollback`, lock transitions to `release` mode; the next pending migration in an `apply` batch can re-enter `migration` mode without manual `release`
- [ ] **LCK-06**: `finalize` acquires the lock in `maintenance` mode — blocks other runners but does NOT gate guarded app traffic
- [ ] **LCK-07**: All lock-row reads from the runner use `ConsistentRead: true`
- [ ] **LCK-08**: `unlock` clears the lock and marks any in-progress migration as `failed`; behavior depends on the lock state at clear time (apply → marked failed; release → equivalent to `release`; finalize → marked failed)
- [ ] **LCK-09**: Multi-migration batch: `release` is refused while `inFlightIds` is non-empty (command-level enforcement, no `batchRunId` field)
- [ ] **LCK-10**: Lock heartbeat watchdog: if the runner detects its own heartbeat write failed twice in a row, it aborts and marks the migration `failed`

### Guard Wrapper

- [ ] **GRD-01**: `createMigrationsClient({config, client, tableName}).guardedClient()` returns a wrapped DynamoDB client (or DocumentClient) that intercepts every call
- [ ] **GRD-02**: Guard reads `_migration_state` lock row using `ConsistentRead: true` (mandatory; not optional)
- [ ] **GRD-03**: Guard caches the lock-row read for `guard.cacheTtlMs` per process; in-flight read deduplicates across concurrent calls
- [ ] **GRD-04**: When lock state is in `apply | finalize | rollback | release | failed | dying`, intercepted calls throw `EDBMigrationInProgressError` with `details: {runId, lockState}`
- [ ] **GRD-05**: `guard.blockMode: 'writes-only'` lets reads through the guard; `'all'` (default) gates both reads and writes
- [ ] **GRD-06**: Guard fails closed: any error reading the lock row throws `EDBMigrationInProgressError` rather than returning success
- [ ] **GRD-07**: Guard cache invalidates correctly after Lambda freeze/thaw and after long event-loop blocks (wall-clock TTL with sample-on-access)

### Apply Runner

- [ ] **RUN-01**: `apply` scans the table for v1 records of the target entity using ElectroDB identity stamps (not raw `pk` prefix)
- [ ] **RUN-02**: For each record, `up()` is called; output is validated against v2's ElectroDB schema; v2 is written alongside v1
- [ ] **RUN-03**: All `BatchWriteItem` calls use a bounded exponential-backoff + full-jitter retry loop on `UnprocessedItems` non-empty (max 5 retries, max delay 30s)
- [ ] **RUN-04**: Count audit invariant: `scanned == migrated + skipped + failed` MUST hold; runner refuses to mark migration `applied` if it doesn't
- [ ] **RUN-05**: Multiple pending migrations are applied back-to-back in a single `apply` invocation; release-mode handoff between them is internal
- [ ] **RUN-06**: `apply --migration <id>` applies only that migration; refuses if not next in sequence
- [ ] **RUN-07**: `apply` is a no-op when no migrations are pending (clean exit, not error)
- [ ] **RUN-08**: On apply failure, migration is marked `failed`; partial v2 writes remain on disk; lock stays held in `failed` state until operator runs `rollback`
- [ ] **RUN-09**: Apply emits success summary including counts, elapsed time, and a numbered checklist with "Run `release` after deploying code" prominent

### Release & Finalize

- [ ] **REL-01**: `release` is a single conditional update on the lock row; clears `release` state if no `inFlightIds`; synchronous and fast
- [ ] **REL-02**: `release` returns clear feedback if there's no active release-mode lock (idempotent no-op)
- [ ] **FIN-01**: `finalize <id>` deletes all v1 records for the named migration under maintenance-mode lock
- [ ] **FIN-02**: `finalize --all` finalizes every applied migration that is past its bake window (no automatic bake-window logic in v0.1; operator decides)
- [ ] **FIN-03**: After successful finalize, migration row is marked `finalized`; lock clears
- [ ] **FIN-04**: Finalize is permanent and irreversible by design (after this, only `projected` rollback strategy is possible)

### Rollback

- [ ] **RBK-01**: `rollback <id>` enforces head-only rule; refuses if a newer applied (non-reverted) migration exists for the same entity (`EDBRollbackOutOfOrderError`)
- [ ] **RBK-02**: Rollback enters migration-mode lock, transitions to release-mode on success
- [ ] **RBK-03**: Case 1 (pre-release): deletes all v2 records; v1 is intact; `down` not required; lossless
- [ ] **RBK-04**: Case 2 (post-release, pre-finalize): four-row-state classification (A/B/C/D) per primary key based on v1/v2 presence
- [ ] **RBK-05**: `--strategy projected` (default; requires `down`): runs `down(v2)` for A and B, deletes v1 mirror for C
- [ ] **RBK-06**: `--strategy snapshot` (works without `down`): keeps original v1 for A and C, deletes v2 for B; CLI prompts with explicit type-B and type-C counts before proceeding
- [ ] **RBK-07**: `--strategy fill-only` (requires `down`): keeps original v1 for A and C, runs `down(v2)` for B
- [ ] **RBK-08**: `--strategy custom` (requires `rollbackResolver` on migration): per-record dispatch to user-supplied function with `{kind, v1Original, v2, down}`; resolver returns v1 record or `null` for delete
- [ ] **RBK-09**: Case 3 (post-finalize): only `projected` and `custom` permitted; `snapshot` and `fill-only` refused with `FINALIZED_ONLY_PROJECTED` reason
- [ ] **RBK-10**: Rollback refusal cases all surface specific `EDBRollbackNotPossibleError` reason codes
- [ ] **RBK-11**: Rollback uses frozen ElectroDB entity instances from `v1.ts`/`v2.ts` for type-table classification (NOT raw `pk`/`sk`) — handles single-table-design entities sharing PK prefixes
- [ ] **RBK-12**: BatchWriteItem retry loop and count audit invariant apply equally to rollback writes

### Cross-Entity Reads

- [ ] **CTX-01**: `up()` and `down()` receive a second arg `ctx` with an `entity(Other)` method
- [ ] **CTX-02**: `ctx.entity(Other)` returns a read-only ElectroDB facade bound to the runner's unguarded client
- [ ] **CTX-03**: Writes attempted via `ctx` throw with a clear "reads-only" error
- [ ] **CTX-04**: `ctx.entity(SelfEntity)` from inside its own migration throws `EDBSelfReadInMigrationError` before hitting DDB
- [ ] **CTX-05**: At call time, `ctx.entity(Y)` validates on-disk Y shape against imported Y; mismatch throws `EDBStaleEntityReadError` naming the conflicting migration
- [ ] **CTX-06**: `defineMigration({ reads: [Entity, ...] })` declares cross-entity dependencies; persisted on `_migrations.reads`
- [ ] **CTX-07**: `validate` refuses any branch where a declared `reads` target has a later-sequenced pending migration
- [ ] **CTX-08**: Rolling back migration M is refused if any migration on a `reads` target has been applied since M

### Validate

- [ ] **VAL-01**: `validate` checks: drift exists with no scaffolded migration → fail
- [ ] **VAL-02**: `validate` checks: entity `model.version` is in sync with the latest scaffolded migration → fail on skew
- [ ] **VAL-03**: `validate` checks: migration sequence increments by 1 starting at 1 (or at `migrationStartVersions[entity]` if configured) → fail on gaps
- [ ] **VAL-04**: `validate` checks: parallel-branch collision (two migrations claim the same `from` version of an entity) → fail
- [ ] **VAL-05**: `validate` checks: cross-entity ordering — every declared `reads` target has no later-sequenced pending migration → fail
- [ ] **VAL-06**: `validate` checks: an entity that previously existed has been removed → fail unless `acknowledge-removal` was run
- [ ] **VAL-07**: `validate` checks: reserved namespace — user entity names cannot start with `_` (collision with framework's internal entities) → fail
- [ ] **VAL-08**: `validate` checks: frozen `v1.ts`/`v2.ts` integrity hash matches scaffold-time hash → fail if user manually edited
- [ ] **VAL-09**: `validate` exits with non-zero status code on any failure; zero status on clean
- [ ] **VAL-10**: `acknowledge-removal <entity>` advances the snapshot to record the entity as intentionally removed; does NOT touch records on disk

### CLI

- [ ] **CLI-01**: Global flags work on every command: `--config <path>`, `--remote`, `--region <region>`, `--table <name>`
- [ ] **CLI-02**: `--remote` is meaningful only on database-touching commands (`apply`, `rollback`, `finalize`, `release`, `status`, `unlock`); ignored on file-only commands
- [ ] **CLI-03**: `status [migration-id]` reports lock state, in-flight runs, and per-migration status (table format by default)
- [ ] **CLI-04**: `history [--entity <name>] [--json]` prints the full migration log (every applied/finalized/reverted/failed migration with timestamps)
- [ ] **CLI-05**: `unlock --run-id <runId>` is required (even with `--yes`) to prevent panic-button misuse
- [ ] **CLI-06**: `unlock` interactive prompt shows `lockState`, `lockHolder`, `lockRunId`, `heartbeatAt`, and elapsed runtime before confirmation
- [ ] **CLI-07**: `unlock --yes` skips the interactive prompt for non-interactive use (CI); `--run-id` is still required
- [ ] **CLI-08**: All CLI output uses `picocolors` for ANSI colors; `yocto-spinner` for in-progress operations; `cli-table3` for tabular data
- [ ] **CLI-09**: Error messages name the specific failing condition and suggest a remediation step

### Programmatic API

- [ ] **API-01**: `createMigrationsClient({config, client, tableName, migrations})` returns a client with all methods
- [ ] **API-02**: Blocking methods: `apply()`, `rollback(id, options)`, `finalize(id|{all:true})`, `release()`, `history(filter?)`
- [ ] **API-03**: Background methods: `runInBackground({command, migrationId, ...})` returns `{runId}`; `getRunStatus(runId)` returns status snapshot
- [ ] **API-04**: Status snapshot shape: `{status, command, migrationId, startedAt, elapsedMs, lastHeartbeatAt, error?}` (no per-record `progress`, no `phase` enum)
- [ ] **API-05**: Operational methods: `forceUnlock({runId, yes})`, `getLockState()`, `getGuardState()`, `guardedClient()`
- [ ] **API-06**: `defineConfig(...)` and `defineMigration(...)` factory functions exported

### Remote Execution

- [ ] **RMT-01**: `createLambdaMigrationHandler({config, client, tableName, apiKey, migrations})` returns a Lambda handler that routes wire-contract POSTs to the migrations client
- [ ] **RMT-02**: Wire contract: `POST <remote.url>` with `X-Api-Key: <remote.apiKey>` and JSON body `{command, args}`
- [ ] **RMT-03**: Async commands (`apply`, `rollback`, `finalize`) start work in the background and return `{runId, status: 'started'}`
- [ ] **RMT-04**: Synchronous commands (`release`, `status`, `history`, `unlock`) return their result inline
- [ ] **RMT-05**: CLI `apply` / `finalize --all` are CLI-tier loops that resolve the pending list locally and POST one request per migration
- [ ] **RMT-06**: Lambda handler watchdog at T-1min before timeout: writes a clean failure marker if the migration won't complete in time
- [ ] **RMT-07**: Pre-flight `Scan COUNT` estimate when `--remote` is used; warns if estimated runtime exceeds Lambda timeout
- [ ] **RMT-08**: Start errors (lock held, validation, no migrations to run) return synchronous error shape `{error: {code, message, details}}` — no `runId` issued
- [ ] **RMT-09**: Run errors surface on `getRunStatus(runId)` as `{status: 'failed', error: {code, message, details}}`

### Testing Harness

- [ ] **TST-01**: `electrodb-migrations/testing` sub-path export is wired through `tsup` and `package.json` `exports` (`types` first in every condition block)
- [ ] **TST-02**: `testMigration(migration, cases)` accepts case shapes: `{input, expectedV2}`, `{roundTrip}`, `{input, expectedV2: 'valid'}`
- [ ] **TST-03**: `testMigration` validates `up()` output against v2's ElectroDB schema automatically (catches mismatched-shape transforms even if user didn't assert the field)
- [ ] **TST-04**: `testMigration` round-trip cases assert `down(up(x))` deep-equals `x`; throws if `down` is missing
- [ ] **TST-05**: `testRollbackResolver(migration, cases)` accepts `{kind: 'A'|'B'|'C', v1Original?, v2?, expected}` cases
- [ ] **TST-06**: Test harness types infer from `migration.from` and `migration.to` for autocomplete on every field
- [ ] **TST-07**: Test functions are framework-agnostic (throw on first failure, return normally on success); README shows vitest wrapping pattern

### Build & Quality

- [ ] **BLD-01**: `tsup.config.ts` defines two builds: library (with `entry` map for `index` and `testing`) and CLI (with shebang banner)
- [ ] **BLD-02**: `package.json` `exports` field has correct condition ordering (`types` first) for `.`, `./testing`, and `./package.json`
- [ ] **BLD-03**: `pnpm test` runs vitest unit tests; `pnpm test:integration` runs vitest against DynamoDB Local in `docker-compose.yml`
- [ ] **BLD-04**: Integration tests cover `ConsistentRead: true` correctness with a mock or harness that simulates DDB's eventual-consistency window (DDB Local alone is not sufficient)
- [ ] **BLD-05**: `pnpm typecheck` runs `tsc --noEmit` clean; `pnpm check` runs `biome check` clean
- [ ] **BLD-06**: `pnpm build` produces `dist/` artifacts that pass `tsc` against `dist/index.d.ts` from a fresh consumer project (smoke check)
- [ ] **BLD-07**: Build verifies `dist/index.js` does not import `ts-morph` (size assertion or import scan)

### Distribution

- [ ] **DST-01**: README.md is the documentation contract; every requirement above is described in a corresponding README section
- [ ] **DST-02**: `npm publish --dry-run` produces a tarball with `dist/` only (per `files` field); no `src`, no `tests`, no `.planning`, no `.research`
- [ ] **DST-03**: `npm install electrodb-migrations` works against ElectroDB 3.0 and the latest 3.x without modification (peer-dep range honored)
- [ ] **DST-04**: First v0.1.0 release is published to npm under the user's own credentials (manual `npm publish` for v0.1; Changesets/CI deferred)

## v2 Requirements

Deferred to future releases per README §14 Future plans.

### Per-Entity Lock Scoping
- **PEL-01**: Lock scope can be configured per-entity instead of table-wide
- **PEL-02**: Migrations on independent entities can run concurrently

### Zero-Downtime Apply
- **ZDA-01**: Live read/write caching during migration runs eliminates the guard's downtime window
- **ZDA-02**: Dual-shape consistent reads during the apply window

### Entity-Deletion Migrations
- **EDM-01**: First-class destructive migration kind (replaces `acknowledge-removal` for the case where the operator wants the framework to manage the deletion under lock)
- **EDM-02**: Optional archive hook ("copy to a separate entity before deleting" pattern)
- **EDM-03**: Same lock + audit + pre-finalize rollback guarantees as transform migrations

### Additional Remote Transports
- **ART-01**: SQS-fronted worker pattern documented + first-class
- **ART-02**: ECS RunTask invocation pattern
- **ART-03**: gRPC transport (lower priority)

### Operational Polish (v0.2 candidates)
- **OPS-01**: `--plan` flag on rollback shows type-table classification counts without acting
- **OPS-02**: Migration squashing (collapse multiple historical migrations into one)
- **OPS-03**: Per-environment config helpers (dev/prod table override patterns)
- **OPS-04**: Multi-region (Global Tables) doc warning + (later) coordination layer
- **OPS-05**: Hosted docs site (Astro Starlight, mirroring ElectroDB's pattern under `www/`)

## Out of Scope

Explicit exclusions to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Per-record progress on lock row | Would contend with heartbeat on the same hot key. `lastHeartbeatAt` freshness is the load-bearing liveness signal (README §3.3) |
| Phase enum on `getRunStatus` (`scanning`/`transforming`/etc.) | Same hot-row contention, marginal value |
| Bundled long-running-server implementation | Framework ships the client; user wires their own ECS/EC2 handler. README §3 documents the pattern |
| Auto-rollback on apply failure | Operator must explicitly run `rollback` after a failed apply — silent rollback obscures failure causes |
| Auto-generated DDL or `prisma db push` equivalent | Doesn't fit DynamoDB's schemaless model; transform-based migration is the design |
| Shadow-DB diff (Prisma-style) | DynamoDB has no DDL; transforms are the only schema-changing operation |
| Foreign-key-aware migration ordering | DDB has no FKs; cross-entity ordering is via `reads` declarations only |
| `migrate reset` command | Destructive; outside the safety model. Operators with a clean-slate need can drop and re-create the table out-of-band |
| Migration squashing (combining multiple migrations into one) | Defer to v0.2; `migrationStartVersions` is the v0.1 escape hatch |
| Interactive migration browser / TUI | CLI tables and machine-readable `--json` output are sufficient |
| GitHub Actions CI for v0.1 | Local-only quality gates during dogfooding; CI added when external PR flow demands it |
| Changesets / automated release pipeline for v0.1 | Manual `npm publish` is fine for early releases; revisit at first publish |
| Hosted docs site for v0.1 | README is the contract. Astro/Starlight precedent (ElectroDB) available if/when v0.2 needs it |
| Built-in observability / OpenTelemetry hooks | Out of scope for v0.1; user can wrap the client |
| Seed data integration | Migrations are for schema transforms, not data seeding |
| Multi-region (Global Tables) coordination | Documented gotcha for v0.1; coordination layer is v0.2+ |
| Web UI for migration status | CLI is the v0.1 interface |

## Traceability

Phase mappings populated by roadmapper on 2026-05-02.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 10 | Pending |
| FND-02 | Phase 1 | Pending |
| FND-03 | Phase 8 | Pending |
| FND-04 | Phase 2 | Pending |
| FND-05 | Phase 1 | Pending |
| FND-06 | Phase 1 | Pending |
| ERR-01 | Phase 1 | Pending |
| ERR-02 | Phase 1 | Pending |
| ERR-03 | Phase 1 | Pending |
| ERR-04 | Phase 1 | Pending |
| ERR-05 | Phase 1 | Pending |
| ERR-06 | Phase 1 | Pending |
| ERR-07 | Phase 1 | Pending |
| ERR-08 | Phase 1 | Pending |
| CFG-01 | Phase 1 | Pending |
| CFG-02 | Phase 1 | Pending |
| CFG-03 | Phase 1 | Pending |
| CFG-04 | Phase 1 | Pending |
| CFG-05 | Phase 1 | Pending |
| CFG-06 | Phase 1 | Pending |
| CFG-07 | Phase 1 | Pending |
| CFG-08 | Phase 1 | Pending |
| CFG-09 | Phase 1 | Pending |
| CFG-10 | Phase 2 | Pending |
| CFG-11 | Phase 1 | Pending |
| ENT-01 | Phase 3 | Pending |
| ENT-02 | Phase 3 | Pending |
| ENT-03 | Phase 3 | Pending |
| ENT-04 | Phase 3 | Pending |
| ENT-05 | Phase 3 | Pending |
| ENT-06 | Phase 3 | Pending |
| SNP-01 | Phase 1 | Pending |
| SNP-02 | Phase 1 | Pending |
| SNP-03 | Phase 2 | Pending |
| SNP-04 | Phase 1 | Pending |
| DRF-01 | Phase 1 | Pending |
| DRF-02 | Phase 1 | Pending |
| DRF-03 | Phase 1 | Pending |
| DRF-04 | Phase 1 | Pending |
| DRF-05 | Phase 2 | Pending |
| DRF-06 | Phase 2 | Pending |
| DRF-07 | Phase 2 | Pending |
| INI-01 | Phase 2 | Pending |
| INI-02 | Phase 2 | Pending |
| INI-03 | Phase 2 | Pending |
| SCF-01 | Phase 2 | Pending |
| SCF-02 | Phase 2 | Pending |
| SCF-03 | Phase 2 | Pending |
| SCF-04 | Phase 2 | Pending |
| SCF-05 | Phase 2 | Pending |
| SCF-06 | Phase 2 | Pending |
| SCF-07 | Phase 2 | Pending |
| SCF-08 | Phase 7 | Pending |
| LCK-01 | Phase 3 | Pending |
| LCK-02 | Phase 3 | Pending |
| LCK-03 | Phase 3 | Pending |
| LCK-04 | Phase 3 | Pending |
| LCK-05 | Phase 3 | Pending |
| LCK-06 | Phase 3 | Pending |
| LCK-07 | Phase 3 | Pending |
| LCK-08 | Phase 3 | Pending |
| LCK-09 | Phase 3 | Pending |
| LCK-10 | Phase 3 | Pending |
| GRD-01 | Phase 3 | Pending |
| GRD-02 | Phase 3 | Pending |
| GRD-03 | Phase 3 | Pending |
| GRD-04 | Phase 3 | Pending |
| GRD-05 | Phase 3 | Pending |
| GRD-06 | Phase 3 | Pending |
| GRD-07 | Phase 3 | Pending |
| RUN-01 | Phase 4 | Pending |
| RUN-02 | Phase 4 | Pending |
| RUN-03 | Phase 4 | Pending |
| RUN-04 | Phase 4 | Pending |
| RUN-05 | Phase 4 | Pending |
| RUN-06 | Phase 4 | Pending |
| RUN-07 | Phase 4 | Pending |
| RUN-08 | Phase 4 | Pending |
| RUN-09 | Phase 4 | Pending |
| REL-01 | Phase 4 | Pending |
| REL-02 | Phase 4 | Pending |
| FIN-01 | Phase 4 | Pending |
| FIN-02 | Phase 4 | Pending |
| FIN-03 | Phase 4 | Pending |
| FIN-04 | Phase 4 | Pending |
| RBK-01 | Phase 5 | Pending |
| RBK-02 | Phase 5 | Pending |
| RBK-03 | Phase 5 | Pending |
| RBK-04 | Phase 5 | Pending |
| RBK-05 | Phase 5 | Pending |
| RBK-06 | Phase 5 | Pending |
| RBK-07 | Phase 5 | Pending |
| RBK-08 | Phase 5 | Pending |
| RBK-09 | Phase 5 | Pending |
| RBK-10 | Phase 5 | Pending |
| RBK-11 | Phase 5 | Pending |
| RBK-12 | Phase 5 | Pending |
| CTX-01 | Phase 6 | Pending |
| CTX-02 | Phase 6 | Pending |
| CTX-03 | Phase 6 | Pending |
| CTX-04 | Phase 6 | Pending |
| CTX-05 | Phase 6 | Pending |
| CTX-06 | Phase 6 | Pending |
| CTX-07 | Phase 6 | Pending |
| CTX-08 | Phase 6 | Pending |
| VAL-01 | Phase 7 | Pending |
| VAL-02 | Phase 7 | Pending |
| VAL-03 | Phase 7 | Pending |
| VAL-04 | Phase 7 | Pending |
| VAL-05 | Phase 7 | Pending |
| VAL-06 | Phase 7 | Pending |
| VAL-07 | Phase 7 | Pending |
| VAL-08 | Phase 7 | Pending |
| VAL-09 | Phase 7 | Pending |
| VAL-10 | Phase 7 | Pending |
| CLI-01 | Phase 2 | Pending |
| CLI-02 | Phase 7 | Pending |
| CLI-03 | Phase 4 | Pending |
| CLI-04 | Phase 4 | Pending |
| CLI-05 | Phase 5 | Pending |
| CLI-06 | Phase 5 | Pending |
| CLI-07 | Phase 5 | Pending |
| CLI-08 | Phase 2 | Pending |
| CLI-09 | Phase 2 | Pending |
| API-01 | Phase 4 | Pending |
| API-02 | Phase 4 | Pending |
| API-03 | Phase 9 | Pending |
| API-04 | Phase 9 | Pending |
| API-05 | Phase 5 | Pending |
| API-06 | Phase 4 | Pending |
| RMT-01 | Phase 9 | Pending |
| RMT-02 | Phase 9 | Pending |
| RMT-03 | Phase 9 | Pending |
| RMT-04 | Phase 9 | Pending |
| RMT-05 | Phase 9 | Pending |
| RMT-06 | Phase 9 | Pending |
| RMT-07 | Phase 9 | Pending |
| RMT-08 | Phase 9 | Pending |
| RMT-09 | Phase 9 | Pending |
| TST-01 | Phase 8 | Pending |
| TST-02 | Phase 8 | Pending |
| TST-03 | Phase 8 | Pending |
| TST-04 | Phase 8 | Pending |
| TST-05 | Phase 8 | Pending |
| TST-06 | Phase 8 | Pending |
| TST-07 | Phase 8 | Pending |
| BLD-01 | Phase 8 | Pending |
| BLD-02 | Phase 8 | Pending |
| BLD-03 | Phase 10 | Pending |
| BLD-04 | Phase 3 | Pending |
| BLD-05 | Phase 10 | Pending |
| BLD-06 | Phase 10 | Pending |
| BLD-07 | Phase 10 | Pending |
| DST-01 | Phase 10 | Pending |
| DST-02 | Phase 10 | Pending |
| DST-03 | Phase 10 | Pending |
| DST-04 | Phase 10 | Pending |

**Coverage:**
- v1 requirements: 157 total
- Mapped to phases: 157 (100%)
- Unmapped: 0

**Phase distribution:**
- Phase 1 (Foundation & Safety Primitives): 28 requirements
- Phase 2 (Drift Detection & Authoring Loop): 19 requirements
- Phase 3 (Internal Entities, Lock & Guard): 24 requirements
- Phase 4 (Apply, Release & Finalize Runner): 20 requirements
- Phase 5 (Rollback Strategies): 16 requirements
- Phase 6 (Cross-Entity Reads): 8 requirements
- Phase 7 (Validate, Regenerate & Acknowledge-Removal): 12 requirements
- Phase 8 (Test Harness): 10 requirements
- Phase 9 (Remote Execution): 11 requirements
- Phase 10 (Build, Quality & v0.1.0 Release): 9 requirements

---
*Requirements defined: 2026-05-02*
*Last updated: 2026-05-02 — traceability populated by roadmapper, coverage 157/157*
