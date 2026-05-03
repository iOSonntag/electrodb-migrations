# electrodb-migrations

A migration system for [ElectroDB](https://electrodb.dev/) on DynamoDB. Drift detection, rollbacks, entities that pause reads and writes while a migration runs, and a Prisma-style developer experience.

**The basic flow**
1. edit your entity
1. create a migration using the CLI
1. fill in the generated `up()` transform
1. apply the migration

```
npm install electrodb-migrations
```

Peer dependencies: `electrodb >= 3.0.0`, `@aws-sdk/client-dynamodb >= 3.0.0`. Node >= 18.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Recommended](#recommended)
- [Docs](#docs)

---

## What it does

You keep a single source-of-truth entity file (e.g. `src/database/entities/user.ts`). When you change its shape, the framework detects the drift, scaffolds a migration folder with frozen v1/v2 snapshots and a transform stub, and walks the table converting v1 records to v2 records under a global lock. After a bake window where v1 and v2 coexist, you finalize and v1 is deleted.

---

## Quick start

> *Quick start covers the production-safe baseline. For CI gating, large datasets, multi-developer teams, rollbacks, testing, cross-entity reads, and entity removal, read [Recommended](#recommended) before going to production.*

### 1. Initialize

```sh
npx electrodb-migrations init
```

Creates `.electrodb-migrations/` (framework-managed state — commit it alongside your code) and `electrodb-migrations.config.ts` pre-populated with options you might want to customize. Every option is optional; see [§5.1](#51-the-config-file) for the full list.

```ts
// electrodb-migrations.config.ts
import { defineConfig } from 'electrodb-migrations';

export default defineConfig({
  entities: 'src/database/entities',
  migrations: 'src/database/migrations',
  tableName: 'app-table',
});
```

### 2. Baseline an existing project

```sh
npx electrodb-migrations baseline
```

Snapshots every entity's current shape so the framework treats production as the starting point. Skip for greenfield projects — your first `create` produces the first snapshot.

### 3. Edit your entity

Change anything including adding/removing indexes and changing primary keys (except `model.entity` and `model.service`). Don't bump `model.version` — the framework does it for you.

```ts
// src/database/entities/user.ts
import { Entity } from 'electrodb';

export const User = new Entity({
  model: { entity: 'User', version: '1', service: 'app' },
  attributes: {
    id: { type: 'string', required: true },
    email: { type: 'string', required: true },
    status: { type: ['active', 'inactive'] as const, required: true }, // ← new field
  },
  // ...
});
```

### 4. Scaffold the migration

```sh
npx electrodb-migrations create --entity User --name add-status
```

The framework generates the migration folder, bumps `model.version` from `'1'` to `'2'` in your entity file (its only edit to your source), updates the snapshot, and prints the diff:

```
migrations/20260501083000-User-add-status/
├── v1.ts              # frozen previous shape
├── v2.ts              # frozen new shape
└── migration.ts       # up() stub for you to fill in

User: v1 → v2
  + status: 'active' | 'inactive'  (required)  ⚠ NEEDS DEFAULT IN up()
```

Behavior-only changes (validators, getters, conditions for sparce indexes) don't trigger drift; pass `--force` if you know one needs data work — see [§10.2](#102-what-does-not-count-as-drift-behavior-only-changes).

### 5. Fill in the transform

```ts
// migrations/20260501083000-User-add-status/migration.ts
import { defineMigration } from 'electrodb-migrations';
import { User as UserV1 } from './v1.js';
import { User as UserV2 } from './v2.js';

export default defineMigration({
  id: '20260501083000-User-add-status',
  entityName: 'User',
  from: UserV1,
  to: UserV2,
  up: async (user) => ({ ...user, status: 'active' as const }),
  // down: async (user) => { const { status: _s, ...v1 } = user; return v1; },
});
```

`up` is required; `down` is optional but required for post-finalize rollback. To read related entities inside the transform, see [Docs → Cross-entity reads](#66-cross-entity-reads).

### 6. Wrap your DynamoDB client with the migration guard

A migration **has** downtime: app traffic must not hit the table while the lock is held. The guard wrapper rejects every guarded call with `EDBMigrationInProgressError` for the duration.

```ts
import { createMigrationsClient } from 'electrodb-migrations';

const client = new DynamoDBClient(...); // or DynamoDBDocumentClient
const migrate = createMigrationsClient({ config, client });
const guarded = migrate.guardedClient();

// Use `guarded` for every Entity (and Service) in your app:
const User = new Entity(userSchema, { client: guarded, table });
```

Surface the error as HTTP 503 with `Retry-After` so clients back off automatically — see [§9.3](#93-edbmigrationinprogresserror) for the recommended handler pattern.

> **⚠ Deploy the guard before your first `apply`.**  
> *Without it, app traffic hits the table mid-migration and may silently corrupt data.*

### 7. Apply

```sh
npx electrodb-migrations apply
```

Acquires the migration lock, scans v1 records, runs `up()` against each, and writes v2 records alongside. Both versions coexist on disk; ElectroDB's identity stamps route v1 reads to v1 records and v2 to v2. On success, the lock transitions to **release mode** — still gating app traffic, no longer gating the migration runner. Multiple pending migrations apply back-to-back in a single invocation. Full state machine in [§1 Locks](#1-locks-migration-release-and-maintenance-modes).

### 8. Deploy your code, then release

Deploy the version of your app that uses the new entity shape. Once it's live and healthy:

```sh
npx electrodb-migrations release
```

The release lock clears. Traffic flows.

### 9. Finalize

After a bake window where nothing is broken:

```sh
npx electrodb-migrations finalize 20260501083000-User-add-status
# OR
npx electrodb-migrations finalize --all
```

Deletes the v1 records and marks the migration `finalized`. Permanent. Acquires the lock in **maintenance mode** — concurrent runners blocked, but app traffic unaffected (the table is in a v2-only steady state). You can defer finalize for weeks; it's an optimization, not a requirement.

---

## Recommended

Quick start covers the production-safe baseline. The blurbs below are a brief tour of the practices that harden it further; details for each live in [Docs](#docs).

### 1. Block bad merges in CI

Run this in your CI pipeline as a pre-merge or pre-deploy gate:

```sh
npx electrodb-migrations validate
```

CI pre-merge gate that blocks drift, version skew, parallel-branch collisions, cross-entity ordering violations, and removed entities. See [Docs → §4.12 validate](#412-validate).

### 2. Performance - running migration on AWS

Running migrations on AWS reduces per-record network round-trips compared to running locally, which matters for large tables. For example, you can use the framework's built-in AWS Lambda helper:

```ts
// src/migrationHandler.ts
import { createLambdaMigrationHandler } from 'electrodb-migrations';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import migrations from './migrations/index.js';
import config from '../electrodb-migrations.config.ts';

export const handler = createLambdaMigrationHandler({
  config,
  client: new DynamoDBClient({}),
  apiKey: process.env.MIGRATIONS_API_KEY,
  tableName: process.env.TABLE_NAME!,
  migrations,
});
```

Then run any database-touching command with `--remote`:

```sh
npx electrodb-migrations apply --remote
```

Other paths (e.g. running the framework inside a long-running container in ECS/EKS) are also supported — see [Docs → §3 Running on a long-running migration server](#3-running-on-a-long-running-migration-server) and [Docs → §4 CLI](#4-cli) for the configuration, the `--remote` semantics, and the operational notes.

### 3. Rollbacks

The framework supports rolling back applied migrations both before and after `finalize`, with three named strategies (`projected`, `snapshot`, `fill-only`) and a custom-resolver escape hatch. Each has different data-loss and reconstruction trade-offs depending on whether the lock is still held, has been released, or the migration has been finalized — read [Docs → §2 Rollback](#2-rollback) before relying on rollback in production.

### 4. Multi-developer workflow

`.electrodb-migrations/` is committed, so parallel branches that both scaffold a migration on the same entity will collide on the frozen snapshots once the first branch merges. The fix is a rebase plus `npx electrodb-migrations create --regenerate <migration-id>`. See [Docs → §11 Multi-developer workflow](#11-multi-developer-workflow) for the collision narrative, the full fix flow, and the long-lived-branch follow-up.

### 5. Test your migrations

The framework ships a unit-test harness so you can validate `up()` (and optionally `down()`) before running `apply` against production data — see [Docs → §8 Testing migrations](#8-testing-migrations).

### 6. Reading from other entities during a migration

`up()` and `down()` receive a `ctx` argument; `ctx.entity(Other)` reads related records under the migration runner's unguarded client. Reach for it sparingly — every read fires once per record and multiplies migration runtime, the lock stays held the whole time, and there are subtle ordering rules between the migration being run and pending migrations on the read target. See [Docs → §6.6 Cross-entity reads](#66-cross-entity-reads) for the ordering rule, the `reads` declaration, the runtime guard, and the three-option conflict-resolution flow.

### 7. Retiring entities

Removing an entity from `entities/` triggers a distinct drift kind (`entity-removed`) that the [`validate`](#412-validate) gate refuses to pass silently — the framework does not ship destructive migrations in v0.1, so the operator must acknowledge the removal explicitly with `npx electrodb-migrations acknowledge-removal <EntityName>`. See [Docs → §4.13 acknowledge-removal](#413-acknowledge-removal) for what the command does (and explicitly does not) do to records on disk.

---

## Docs

Deep dives on the parts of the framework you don't need on day one.

### 1. Locks: migration, release, and maintenance modes

The framework holds a single global lock on your table while any migration-system operation is in progress. The lock has three distinct states.

> **Warning — lock scope is table-wide.**  
> *The lock applies to the entire DynamoDB table, not just the entity being migrated. If your table holds ten entities and you migrate one, the [guard wrapper](#6-wrap-your-dynamodb-client-with-the-migration-guard) rejects traffic for all ten — every entity on that table takes the migration's downtime. This is the simple correct default for v0.1; per-entity lock scoping is on the roadmap.*

| State | Blocks other runners? | Gates app traffic via guard? | Used by |
|---|---|---|---|
| `migration` | yes | yes | `apply`, `rollback` (active phase) |
| `release` | yes | yes | post-`apply` / post-`rollback`, until `release` is called |
| `maintenance` | yes | **no** | `finalize` |

**Migration mode.** Held while `apply` (or `rollback`) is actively scanning, transforming, and writing records. Concurrent migration-system runners are blocked. If you've wired the [guard wrapper](#6-wrap-your-dynamodb-client-with-the-migration-guard), app traffic is rejected for the duration.

**Release mode.** After `apply` finishes successfully, the lock automatically transitions to release mode. The migration is on disk, but your application code is presumably still on the old shape. The release-mode lock keeps app traffic gated until you confirm the new code is deployed and call `release`. The migration runner itself is **not** gated by release mode — the next pending migration in an `apply` batch can re-enter migration mode immediately, without an intervening manual `release`.

**Maintenance mode.** Held by `finalize` while v1 records are being deleted. Concurrent runners are still blocked, but app traffic flows — the table is in a v2-only steady state by this point, so there is no schema mismatch a guarded read or write could hit. This avoids gating user traffic for a step that is often deferred for weeks (see [Quick start → Finalize](#9-finalize)).

The typical sequence:

1. Run `apply`. Lock enters migration mode.
2. `apply` completes. Lock transitions to release mode.
3. Deploy the version of your app that uses the new entity shape.
4. Run `release`. Lock cleared. Traffic resumes.
5. *(later, possibly much later)* Run `finalize`. Lock enters maintenance mode for the duration of the v1 cleanup, then clears.

This three-state design lets you run database migrations and code deploys *in the order that makes sense for each*, without leaving a window where the deployed code expects a shape the data hasn't reached yet — and without paying for downtime during the v1 cleanup that follows.

**Manual recovery (`unlock`).** If a runner dies mid-operation — process killed, ECS task terminated without graceful shutdown, server crashed — the lock row stays held until the stale-takeover threshold expires (a few hours by default). To skip the wait, the operator can clear the lock manually via the CLI's `unlock` command. The effect depends on which state the lock was in:

- `migration` (apply/rollback) → in-progress migration flipped to `failed`. Next `apply` refuses and demands a `rollback` first — partial writes from the dead runner must not be silently treated as a clean slate.
- `release` → the run had already completed successfully; `unlock` simply clears the lock (equivalent to running `release`).
- `maintenance` (finalize) → in-progress finalize flipped to `failed`. The migration stays `applied`; the operator can re-run `finalize` to resume the v1 cleanup.

> **Warning:**  
> *`unlock` assumes no runner is actually alive. If a runner is still working when you unlock, you will corrupt the migration state. The CLI prompts for confirmation by default and will tell you which runId currently holds the lock.*

### 2. Rollback

Rollback is gated by the same global lock as `apply`. It always takes a specific migration id and the framework refuses to roll back anything other than the **head** — the most recent applied (and not yet reverted) migration on that entity. No skipping, no cascades. To roll back further, roll back the head, then the new head, and so on.

```sh
npx electrodb-migrations rollback 20260501083000-User-add-status
# or against the configured remote runner
npx electrodb-migrations rollback 20260501083000-User-add-status --remote
```

The lock is symmetric with `apply`: rollback enters migration mode, then transitions to release mode on success. After deploying the old code, call `release` to clear the lock.

What happens on disk depends on **where in the lifecycle** the migration is — specifically, whether `release` has already been called. That's the point at which app traffic could have written fresh v2 records that have no v1 mirror.

#### 2.1 Case 1 — Rollback before `release` (lock still in release mode)

Every v2 record on disk is a transformed copy of a v1 record; v1 is intact. The framework deletes the v2 records. `down` is **not** required. Fully lossless.

> **Note:**  
> *This applies also for failed migrations that never made it to release mode.*

#### 2.2 Case 2 — Rollback after `release`, before `finalize` (lock cleared, app live)

The app has been writing under v2 between `release` and now, so the table is no longer a uniform pre-apply snapshot. Each primary key is in one of four states:

| Type | v1 on disk? | v2 on disk? | Meaning                                                                                  |
|------|-------------|-------------|------------------------------------------------------------------------------------------|
| A    | yes         | yes         | Old record. v1 is the apply-time snapshot; v2 may have been *updated* by the live app.   |
| B    | no          | yes         | Fresh record. Created by the live app post-release. No v1 mirror.                        |
| C    | yes         | no          | Old record *deleted* by the live app post-release. v1 mirror still on disk.              |
| D    | no          | no          | Created and deleted post-release. Nothing to do.                                         |

What you want done with each type depends on whether you trust the app's post-release activity. The framework offers three named strategies; pick one with `--strategy <name>`. For anything beyond these, ship a `rollbackResolver` and use `--strategy custom`.

##### 2.2.1 `projected` (default; requires `down`)

The post-release v2 state is the truth. Project it back through `down()` to rebuild v1.

| Type | Action                                                                          |
|------|---------------------------------------------------------------------------------|
| A    | Run `down(v2)`. Overwrites the original v1 with the down-derived version.       |
| B    | Run `down(v2)`. Writes a derived v1. Fresh records preserved.                   |
| C    | Delete the v1 mirror. Honors the app-side deletion.                             |

Net: v1 ≡ projection of v2 through `down`. Lossless with respect to post-release activity. **Discards** the *original* v1 records — they're overwritten by the down-derived versions.

##### 2.2.2 `snapshot` (works without `down`)

Restore v1 to its state at apply time. The post-release period is treated as if it never happened.

| Type | Action                                                                          |
|------|---------------------------------------------------------------------------------|
| A    | Keep the original v1. Ignores post-release updates.                             |
| B    | Delete the v2. Fresh records lost.                                              |
| C    | Keep the v1. Resurrects app-deleted records.                                    |

Net: v1 ≡ snapshot at apply time. Loses everything that happened post-release. Use this when post-release writes are known-bad and you explicitly want to discard them.

> **Warning:**  
> *`snapshot` deletes every fresh v2 record (Type B) without recovery, and resurrects every app-deleted record (Type C). The CLI prints both counts and prompts for confirmation before proceeding.*

##### 2.2.3 `fill-only` (hybrid; requires `down`)

Keep originals where they exist; fill in from v2 only where they don't.

| Type | Action                                                                          |
|------|---------------------------------------------------------------------------------|
| A    | Keep the original v1. Ignores post-release updates.                             |
| B    | Run `down(v2)`. Fills in fresh records.                                         |
| C    | Keep the v1. Resurrects app-deleted records.                                    |

Net: original v1 ∪ down-derived fills. Closest to "every record I ever had still persists, in v1 shape."

##### 2.2.4 `custom` (advanced; requires `rollbackResolver`)

For per-field merge or any logic the named strategies don't cover, ship a resolver function on the migration:

```ts
defineMigration({
  // ...
  down: async (v2) => {
    const { status: _s, ...v1 } = v2; // derive v1 from v2 — shape depends on the migration
    return v1;
  },
  rollbackResolver: async ({
    kind,        // 'A' | 'B' | 'C'
    v1Original,  // undefined for B
    v2,          // undefined for C
    down,        // (v2) => Promise<V1>
  }) => {
    // return a v1 record to write, or null to delete this primary key
  },
});
```

Invoked with `--strategy custom`. The framework refuses at start time if `rollbackResolver` isn't defined on the migration.

#### 2.3 Case 3 — Rollback after `finalize`

The v1 records are already gone, so every v2 record is effectively Type B. Only `projected` is sensible — `snapshot` has nothing to keep, `fill-only` has nothing to fall back to. The framework refuses both on a finalized migration.

`down` is **required**; without it the framework throws `EDBRollbackNotPossibleError({ reason: 'NO_DOWN_FUNCTION' })`. `--strategy custom` is permitted if a `rollbackResolver` is defined; the resolver will only ever see `kind: 'B'` in this case.

#### 2.4 Refusal cases

- A newer applied migration exists for the same entity → `EDBRollbackOutOfOrderError`.
- The migration is `pending` or already `reverted` → friendly no-op message.
- `--strategy projected` or `fill-only` without `down` defined → `EDBRollbackNotPossibleError({ reason: 'NO_DOWN_FUNCTION' })`.
- `--strategy custom` without `rollbackResolver` defined → `EDBRollbackNotPossibleError({ reason: 'NO_RESOLVER' })`.
- `--strategy snapshot` or `fill-only` on a finalized migration → `EDBRollbackNotPossibleError({ reason: 'FINALIZED_ONLY_PROJECTED' })`.

> **Note:**  
> *If you have multiple unfinalized migrations stacked on top of each other, each one carries its own gap window from when it was released. The head rule keeps each rollback to one decision at a time — the framework does not cascade.*

### 3. Running on a long-running migration server

The Lambda approach in [Recommended → Performance](#2-performance---running-migration-on-aws) is the simplest path, but it's bounded by Lambda's 15-minute execution limit. For large tables run the framework inside a long-running Node process — typically an ECS task, an EC2 instance, or any container.

The framework does not ship a server. It gives you a migrations client; you decide how to receive commands and route them to it.

#### 3.1 What your server process does

Inside your handler you import the migrations and build a single migrations client. Reuse it across requests; it caches the lock state and other metadata.

```ts
// src/database/migrationserver.ts
import { createMigrationsClient } from 'electrodb-migrations';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import migrations from './migrations/index.js';
import config from '../electrodb-migrations.config.ts';

const client = new DynamoDBClient({});
const migrate = createMigrationsClient({
  config,                 // migrationStartVersions, lock.*, guard.* defaults — see §5.4
  client,
  tableName: 'app-table',
  migrations,
});
```

#### 3.2 Invoking the migrations client

The client exposes one method per CLI command. Each one acquires the lock, does its work, and releases or transitions it as appropriate.

`apply`, `rollback`, and `finalize` can take long enough to outlast any HTTP socket in front of your server (ALB defaults to 60s, API Gateway to 30s). For an HTTP handler, use the background pair so the request can return immediately with a `runId` that the caller polls:

```ts
// kick off in the background; resolves once the run is registered, not when it finishes
const { runId } = await migrate.runInBackground({ migrationId: '20260501083000-User-add-status', command: 'apply' });

// snapshot the current state of a run (poll this from your `status` endpoint)
const snapshot = await migrate.getRunStatus(runId);
// {
//   status: 'running' | 'completed' | 'failed',
//   command: 'apply' | 'rollback' | 'finalize',
//   migrationId: string,
//   startedAt: string,         // ISO-8601
//   elapsedMs: number,         // derived from startedAt at read time
//   lastHeartbeatAt: string,   // ISO-8601 — load-bearing liveness signal
//   error?: { code, message, details },  // present only when status === 'failed'
// }
```

> *No per-record `progress` or phase enum — heartbeat freshness is the liveness signal. See [§3.3](#33-http-wire-contract-for---remote) for the rationale.*

`release` is fast (a single conditional update) and stays blocking:

```ts
await migrate.release();                                           // returns { released: true }
```

`history` is a read-only query against the migration state log — also fast and synchronous. It never acquires the lock.

```ts
const { migrations } = await migrate.history();                       // full log
const { migrations } = await migrate.history({ entityName: 'User' }); // filter to one entity
```

Blocking variants (`migrate.apply()`, `migrate.rollback(id)`, `migrate.finalize(id)`) are still available — the local CLI uses them directly. Use them when you control the caller and don't need a status channel.

Errors thrown by these methods are instances of `EDBMigrationError`. The most common ones to surface to the caller:

- `EDBMigrationLockHeldError` — another runner holds the lock.
- `EDBRequiresRollbackError` — a previous `apply` failed mid-run; the head migration must be rolled back before any new `apply`.
- `EDBRollbackNotPossibleError` — `down` is missing in a case that requires it (see [Docs → Rollback](#2-rollback)).
- `EDBRollbackOutOfOrderError` — the requested migration is not the head.

Errors are split into two categories: **start errors** (validation, lock held, no migrations to run) are thrown synchronously by `runInBackground` before a `runId` is issued. **Run errors** (failures during execution) surface on the snapshot returned by `getRunStatus` as `{ status: 'failed', error: { code, message, details } }`.

#### 3.3 HTTP wire contract for `--remote`

If you want the local CLI's `--remote` flag to drive your server, your endpoint has to accept the contract the CLI sends. Any transport works (HTTP, an SQS-fronted worker, an ECS RunTask invocation) — but `--remote` itself is HTTPS and posts a single shape:

```
POST <remote.url>
X-Api-Key: <remote.apiKey>
Content-Type: application/json

{ "command": "<apply|rollback|finalize|release|status|history|unlock>", "args": { ... } }
```

The contract is **async**: `apply`, `rollback`, and `finalize` start the work in the background and return a `runId` immediately. The CLI then polls `status` until the run reaches a terminal state. `release` and `status` are synchronous.

Per-command body and success response:

| command    | sync/async | args                                                | response (success)                                           |
|------------|------------|-----------------------------------------------------|--------------------------------------------------------------|
| `apply`    | async      | `{ migrationId: string }`                           | `{ runId: string, status: 'started' }`                       |
| `rollback` | async      | `{ migrationId: string, strategy?: 'projected' \| 'snapshot' \| 'fill-only' \| 'custom' }` | `{ runId: string, status: 'started' }`     |
| `finalize` | async      | `{ migrationId: string }`                           | `{ runId: string, status: 'started' }`                       |
| `release`  | sync       | `{}`                                                | `{ released: true }`                                         |
| `status`   | sync       | `{ runId: string }`                                 | see *status response* below                                  |
| `history`  | sync       | `{ entityName?: string }`                           | `{ migrations: MigrationRecord[] }`                          |
| `unlock`   | sync       | `{ runId?: string }`                                | `{ unlocked: true, markedFailed: string[] }`                 |

Each async command targets exactly one migration. The CLI's `apply` / `finalize --all` commands are CLI-tier loops that resolve the pending list locally and POST one request per migration in sequence — "apply all" or "finalize all" never crosses the wire as a single call. This is what gives every migration its own 15-minute Lambda budget instead of forcing the whole batch through one invocation.

Status response shape:

```json
{
  "status": "running" | "completed" | "failed",
  "command": "apply" | "rollback" | "finalize",
  "migrationId": "20260501083000-User-add-status",
  "startedAt": "2026-05-01T08:30:00Z",
  "elapsedMs": 30000,
  "lastHeartbeatAt": "2026-05-01T08:30:28Z",
  "error": { "code": "EDBRollbackNotPossibleError", "message": "...", "details": { } }
}
```

`error` is present once `status` is `failed`. The run targets exactly one migration, named by `migrationId` — no per-batch result aggregation, since a run is one lock cycle on one migration.

> **Why no per-record progress counter or phase?**
> *Tracking `current` / `total` would mean writing back to the lock row on every batch — contending with the heartbeat on the same hot key — and `total` isn't known without an extra full-table pre-scan. A coarser phase enum (`scanning` / `transforming` / ...) would still cost writes on the hot row for marginal value. **Heartbeat freshness is the load-bearing liveness signal**: if `lastHeartbeatAt` is recent, the runner is alive; if it has gone stale past the configured threshold, the lock is up for takeover. `elapsedMs` is derived from `startedAt` at read time, not stored.*

If a `start` request fails before a run is registered (lock held, validation error, no migrations to run), the response is the synchronous error shape — no `runId` is issued:

```json
{ "error": { "code": "EDBMigrationLockHeldError", "message": "...", "details": { } } }
```

Your handler validates the api key, switches on `command`, and routes to `migrate.runInBackground(...)` for the async commands or `migrate.getRunStatus(...)` for `status`. The framework deliberately does not prescribe Express, Fastify, or Koa — pick what fits your stack.

#### 3.4 Operational notes

The process must stay up for the duration of an `apply` or `rollback`. The framework holds the lock with periodic heartbeats; if the process dies mid-run, the lock falls back to its stale-takeover threshold (a few hours by default) before another runner can take over. Both intervals are configurable — see [§5.1.3 `lock`](#513-lock) for the options and [§5.4](#54-how-settings-reach-the-runtime) for how they reach this server.

If a task dies mid-migration and you don't want to wait out the stale-takeover threshold, the CLI's `unlock` command clears the lock and marks any in-progress migration as `failed`. Read its full docs before reaching for it — used incorrectly, it will corrupt migration state.

### 4. CLI

The CLI is the primary entry point for day-to-day use. Every command inherits the [global options](#41-global-options); command-specific flags are listed below each subsection.

#### 4.1 Global options

| Flag | Purpose |
|---|---|
| `--config <path>` | Path to the config file. Default: auto-resolved from project root. Ignored by `init` (no config exists yet). |
| `--remote` | Send the command to the configured `remote` endpoint instead of executing locally. Requires `remote.url` and `remote.apiKey` in the config. Only meaningful for database-touching commands (`apply`, `rollback`, `finalize`, `release`, `status`, `unlock`); ignored by file-only commands (`init`, `baseline`, `create`, `validate`, `acknowledge-removal`). |
| `--region <region>` | Override `config.region`. Used by database-touching commands only. |
| `--table <name>` | Override `config.tableName`. Used by database-touching commands only. |

#### 4.2 init

Bootstraps the project — creates `.electrodb-migrations/`, the migrations directory, and the config file with sensible defaults pre-populated. Config-override globals do not apply (the file does not exist yet).

| Flag | Purpose |
|---|---|
| `--force` | Re-initialize even when `electrodb-migrations.config.ts` already exists. Overwrites. |

#### 4.3 baseline

Snapshot the current shape of every entity into the framework's internal state without scaffolding any migration. Use once on adoption; greenfield projects skip it. No command-specific flags.

#### 4.4 create

Scaffold a migration after editing an entity, or re-frame an existing one after a rebase.

> **Side effect — edits your entity source file.**  
> *`create` bumps `model.version` in the entity file (e.g. `'1' → '2'`). This is the only edit the framework ever makes to your source code. `--regenerate` does the same when the new baseline has advanced past the migration's current `to` version.*

| Flag | Purpose |
|---|---|
| `--entity <name>` | Required (unless using `--regenerate`). The entity to scaffold a migration for. |
| `--name <slug>` | Required (unless using `--regenerate`). Human-readable slug appended to the migration id. |
| `--force` | Scaffold even when no shape drift is detected. Use for behavior-only changes that still need data work. |
| `--regenerate <id>` | Re-frame an existing migration onto the new baseline after a rebase. Preserves your `up()`/`down()`; rewrites `v1.ts`/`v2.ts`. |

#### 4.5 apply

Apply every pending migration in sequence. Each acquires the lock, transforms records, and transitions to release-mode on success.

| Flag | Purpose |
|---|---|
| `--migration <id>` | Apply only this migration. Refuses if it is not the next pending migration in the sequence — order is enforced. |

#### 4.6 release

Clear the release-mode lock after deploying app code that uses the new entity shape. No command-specific flags.

#### 4.7 finalize

Permanently delete the v1 records for an applied migration. Takes the migration id as a positional argument, or `--all`. Acquires the lock in **maintenance mode** — blocks other runners but lets app traffic continue (see [Docs → Locks](#1-locks-migration-release-and-maintenance-modes)).

| Flag | Purpose |
|---|---|
| `--all` | Finalize every applied migration whose post-apply bake window has elapsed. |

#### 4.8 rollback

Roll back the head migration of an entity. Takes the migration id as a required positional argument.

| Flag | Purpose |
|---|---|
| `--strategy <name>` | One of `projected` (default; requires `down`), `snapshot`, `fill-only` (requires `down`), `custom` (requires `rollbackResolver`). See [§2 Rollback](#2-rollback). |

#### 4.9 status

Inspect lock state and migration progress. Takes an optional migration id as a positional argument; without one, reports on all in-flight runs and the global lock state. No command-specific flags.

#### 4.10 history

Print the complete migration log — every applied, finalized, reverted, or failed migration with their timestamps and status transitions. Read-only; never acquires the lock.

| Flag | Purpose |
|---|---|
| `--entity <name>` | Filter to migrations on a single entity. |
| `--json` | Emit machine-readable JSON instead of the human-readable table. |

#### 4.11 unlock

Manual lock recovery — clears the lock and marks any in-progress migration as `failed`. Read [Docs → Locks](#1-locks-migration-release-and-maintenance-modes) before using.

| Flag | Purpose |
|---|---|
| `--yes` | Skip the interactive confirmation prompt. Required for non-interactive use (CI). |

#### 4.12 validate

CI pre-merge gate. Exits non-zero on drift without scaffolded migration, version skew, parallel-branch collisions, cross-entity ordering violations, or removed entities. No command-specific flags.

#### 4.13 acknowledge-removal

Advance the framework's snapshot to record an entity as intentionally removed. Takes the entity name as a required positional argument. Does not touch records on disk. No command-specific flags.

### 5. Configuration reference

#### 5.1 The config file

`defineConfig` is the single source of truth for the framework. The CLI reads the file directly; runtime APIs (`createMigrationsClient`, `wrapClientWithMigrationGuard`, `createLambdaMigrationHandler`) accept its return value as a `config` argument so every process — CLI, app, migration runner — sees the same values. See [§5.4](#54-how-settings-reach-the-runtime) for the wiring patterns.

The config file lives at the project root (same convention as `vitest.config.ts`, `tsup.config.ts`, etc.). Supported extensions: `.ts`, `.js`, `.mjs`, `.cjs`, `.json`. **Every option is optional** — `init` pre-populates `entities`, `migrations`, and the `keyNames` defaults so a fresh project works out-of-the-box.

##### 5.1.1 Top-level options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `entities` | `string \| string[]` | `'src/database/entities'` | Directory (recursive) or explicit file list of ElectroDB entities. Pre-populated by `init`. |
| `migrations` | `string` | `'src/database/migrations'` | Directory the CLI writes migration folders into. Pre-populated by `init`. |
| `region` | `string` | auto-detect → `'us-east-1'` | AWS region for the DynamoDB client. If omitted, uses the region the runner is in (env vars like `AWS_REGION`, EC2/Lambda metadata, SDK default chain). When no region can be detected, falls back to `us-east-1`. |
| `tableName` | `string` | — | DynamoDB table name. Override at the CLI (`--table`) or by passing `tableName` to a runtime API. |

##### 5.1.2 `keyNames`

Override the default attribute names if your table uses different ones (e.g. `PK` / `SK`, or renamed ElectroDB marker fields).

| Option | Type | Default | Purpose |
|---|---|---|---|
| `keyNames.partitionKey` | `string` | `'pk'` | Partition-key attribute name on your table. |
| `keyNames.sortKey` | `string` | `'sk'` | Sort-key attribute name on your table. |
| `keyNames.electroEntity` | `string` | ElectroDB default (currently `__edb_e__`) | ElectroDB entity-name marker field. Override only if you've already renamed it on your own entities. |
| `keyNames.electroVersion` | `string` | ElectroDB default (currently `__edb_v__`) | ElectroDB entity-version marker field. Override only if you've already renamed it on your own entities. |

When you don't override these, the framework forwards no `identifiers` option to ElectroDB; ElectroDB uses its own defaults (currently `__edb_e__` and `__edb_v__`). The framework intentionally does not freeze those values — if a future ElectroDB version changes them, this library follows automatically.

##### 5.1.3 `lock`

Lock-row tuning, used by the migration runner.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `lock.heartbeatMs` | `number` | `30_000` | How often the active runner refreshes its lock heartbeat. |
| `lock.staleThresholdMs` | `number` | `4 * 60 * 60_000` (4h) | Wall time after `lastHeartbeatAt` before another runner may take over a dead lock. |
| `lock.acquireWaitMs` | `number` | `15_000` | Pause between lock acquisition and starting transform work. **Sized so guard caches expire — see [§5.3](#53-lock-and-guard-timing-safety-invariant).** |

##### 5.1.4 `guard`

Guard wrapper tuning, used by every guarded app process.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `guard.cacheTtlMs` | `number` | `5_000` | Per-process TTL for the cached lock-row `GetItem`. **Must be `< lock.acquireWaitMs` — see [§5.3](#53-lock-and-guard-timing-safety-invariant).** |
| `guard.blockMode` | `'all' \| 'writes-only'` | `'all'` | Which guarded calls reject with `EDBMigrationInProgressError`. `'all'` (default) gates reads and writes — the recommended posture, since reading mid-migration data through a stale schema can silently mis-deserialize. `'writes-only'` keeps reads flowing for read-heavy apps that tolerate stale-shape reads but still need writes blocked. |

> **⚠ Load-bearing inequality.**  
> *`guard.cacheTtlMs` must be strictly less than `lock.acquireWaitMs`. The framework refuses to start otherwise. See [§5.3](#53-lock-and-guard-timing-safety-invariant) for why and how to tune both safely together.*

##### 5.1.5 `remote`

Remote-runner endpoint used by every CLI command's `--remote` flag.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `remote.url` | `string` | — | Endpoint receiving `--remote` POSTs (Lambda URL, ALB, etc.). |
| `remote.apiKey` | `string` | — | Sent as `X-Api-Key` to gate the remote handler. |

Both fields are individually optional on the config file (either can come from a CLI flag or a runtime arg), but when `remote` is set the framework throws `EDBConfigInvariantViolationError` at start-time if either field fails to reach the resolved config from some layer. Either supply both `url` and `apiKey`, or omit `remote` entirely.

##### 5.1.6 `migrationStartVersions`

Per-entity starting version for the migration sequence. Set when older migrations have been deleted and the entity's history no longer starts at v1. (Distinct from the `baseline` CLI command, which snapshots current entity shapes during adoption.)

| Option | Type | Default | Purpose |
|---|---|---|---|
| `migrationStartVersions` | `Record<string, { version: number }>` | `{}` | `{ User: { version: 5 } }` declares the next User migration begins at v5→v6. Read by both `validate` (CI gate, see [Recommended → Block bad merges in CI](#1-block-bad-merges-in-ci)) and the migration runner — single source so they cannot disagree. |

#### 5.2 Config file resolution and lookup order

#### 5.3 Lock and guard timing safety invariant

The migration runner acquires the lock, waits `lock.acquireWaitMs`, then mutates data. The guard wrapper — running inside every app process — caches the lock-row read for `guard.cacheTtlMs`. Both numbers are configurable; their relationship is not.

> **⚠ `guard.cacheTtlMs < lock.acquireWaitMs`.**  
> *This is the only configuration constraint the framework validates at startup. The runner refuses to acquire the lock if its config violates it.*

**What goes wrong if violated.** A guarded app process reads the lock row at T=0 and caches "unlocked". The migration runner acquires the lock at T+0.5s. If `cacheTtlMs >= acquireWaitMs`, the guarded process's cache is still valid when the runner finishes its wait window and begins writing v2 records. Every guarded call in that overlap goes to the wire and lands on a half-migrated table — exactly the corruption the guard exists to prevent.

**Recommended defaults.**

| Setting | Default | Rationale |
|---|---|---|
| `guard.cacheTtlMs` | `5_000` | One `GetItem` per process per 5s — negligible at any scale. |
| `lock.acquireWaitMs` | `15_000` | 3× the cache TTL — every cached entry has expired with margin before any write. |
| `lock.heartbeatMs` | `30_000` | Frequent enough to detect a dead runner within minutes; rare enough not to hot-spot the lock row. |
| `lock.staleThresholdMs` | `14_400_000` (4h) | Multi-hour Lambda/ECS scenarios; operators using `unlock` are the fast path. |

**Tuning.** Keep the 3× ratio between `cacheTtlMs` and `acquireWaitMs`. A fleet sensitive to per-process `GetItem` cost can shrink to `1_000` / `3_000`. Wide clock skew across regions can push both up proportionally. Never tune one without the other.

See also: [Docs → Locks](#1-locks-migration-release-and-maintenance-modes), [Quick start → Wrap your DynamoDB client with the migration guard](#6-wrap-your-dynamodb-client-with-the-migration-guard).

#### 5.4 How settings reach the runtime

The CLI reads `electrodb-migrations.config.ts` directly — `validate`, `create`, local `apply`, etc. all auto-resolve the file. Runtime APIs do **not** auto-resolve it from disk; that wouldn't survive bundling into Lambda or shipping to ECS. Instead, the user imports the config file in their runtime code and passes it as the `config` argument to whichever client they construct. Every option declared in the config — `migrationStartVersions`, `keyNames`, `lock.*`, `guard.*`, `region`, default `tableName` — flows through that single argument.

```ts
// src/migrationHandler.ts
import { createLambdaMigrationHandler } from 'electrodb-migrations';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import migrations from './migrations/index.js';
import config from '../electrodb-migrations.config.ts';

export const handler = createLambdaMigrationHandler({
  config,                                 // migrationStartVersions, lock.*, guard.* defaults all live here
  migrations,                             // runtime-only — the imported migration list
  client: new DynamoDBClient({}),         // runtime-only — DDB client instance
  tableName: Resource.AppTable.name,      // optional override of config.tableName
  apiKey: process.env.MIGRATIONS_API_KEY, // runtime-only — env-sourced
});
```

**What's split between the two arg surfaces.**

| Comes from `config` | Comes from runtime args |
|---|---|
| `migrationStartVersions`, `keyNames`, `lock.*`, `guard.*`, `region` | DynamoDB `client` instance, `migrations` array, `apiKey`, env-sourced or SST-resolved overrides of `tableName` |

**Override precedence.** Explicit runtime arg > CLI flag (CLI only) > `config.<field>` > built-in default. Runtime APIs only let you override values that vary per process — `tableName`, `apiKey`. The lock/guard knobs are read from `config` exclusively so they cannot drift between the runner and the guard.

**Project layout.** The config file lives at project root by convention. In monorepos where the migration server is a separate package, a shared `packages/migration-config` exporting the `defineConfig` result keeps everything in one place. Either way, the *only* source of truth is the file imported into every runtime entry point.

### 6. Migration definition reference

#### 6.1 up

#### 6.2 down

#### 6.3 rollbackResolver

#### 6.4 Behavior-only changes (and when to use --force)

#### 6.5 reads

#### 6.6 Cross-entity reads

`up()` and `down()` receive a second `ctx` argument. Use `ctx.entity(Other)` to read related records — bound to the migration runner's unguarded client so it works while the lock is held. Reads only: writes through `ctx` throw, and reading the entity currently being migrated (`ctx.entity(User)` from inside a User migration) also throws — its on-disk state is mid-flight and reads would be order-dependent. **Don't reach for this lightly.**

> **⚠ Discouraged by default — every read multiplies your migration runtime.**  
> *Reads inside `up()`/`down()` fire once per record, serially against your migration's throughput budget. Over a million-row table, one extra read per row is a million extra `GetItem` calls before the migration can finish — and the lock stays held the whole time. Almost always faster: denormalize differently, or pre-load the lookup table into memory in your runner before invoking `apply`.*

##### 6.6.1 Cross-entity ordering rule

When migration `M` reads entity `Y` via `ctx.entity(Y)`, the on-disk shape of `Y` must match the source `Y` you imported. That holds iff every pending migration on `Y` is sequenced *before* `M`. If `Y` has any migration sequenced after `M`, on-disk `Y` is still at an older shape and the read would silently mis-deserialize.

##### 6.6.2 Declare what you read

Add a `reads` field to `defineMigration` listing every entity the transform touches via `ctx.entity()`:

```ts
import { Team } from '../../entities/team.js';

defineMigration({
  entityName: 'User',
  from: UserV1,
  to: UserV2,
  reads: [Team],
  up: async (user, ctx) => {
    const team = await ctx.entity(Team).get({ id: user.teamId }).go();
    return { ...user, teamName: team.data.name };
  },
});
```

The framework uses `reads` for two things:

- **CI gate.** [`validate`](#412-validate) refuses any branch where a declared `reads` target has a later-sequenced pending migration. The error names both migrations and points at the fix.
- **Rollback ordering.** Rolling back `M` is refused if any migration on a `reads` target has been applied since `M`; those must be rolled back first. The head rule already enforces this within a single entity; `reads` extends it across entities.

##### 6.6.3 Runtime guard (the safety net)

Even without `reads` declared, `ctx.entity(Y)` checks at call time that on-disk `Y` matches the imported source. On mismatch it throws `EDBStaleEntityReadError` *before* hitting DynamoDB, naming the conflicting migration. The same call also throws `EDBSelfReadInMigrationError` if you try to read the entity currently being migrated.

The runtime guard catches forgotten declarations; the `reads` declaration catches the same problem at PR review time, before a production apply. Use both.

##### 6.6.4 Resolving a conflict

When `validate` flags a cross-entity ordering conflict, you have three options:

1. **Re-timestamp** so the read target's migration runs first.
2. **Combine** both changes into a single migration if they're tightly coupled.
3. **Stop denormalizing** across that boundary — compute the value a different way that doesn't require the cross-entity read.

### 7. Programmatic API

#### 7.1 createMigrationsClient

#### 7.2 Client methods

##### 7.2.1 apply

##### 7.2.2 rollback

##### 7.2.3 finalize

##### 7.2.4 release

##### 7.2.5 runInBackground

##### 7.2.6 getRunStatus

##### 7.2.7 forceUnlock

##### 7.2.8 getLockState

##### 7.2.9 getGuardState

##### 7.2.10 guardedClient

#### 7.3 createLambdaMigrationHandler

#### 7.4 defineConfig

#### 7.5 defineMigration

### 8. Testing migrations

Migrations are exactly the code you most want tested before running against production. The framework ships a small unit-test harness at `electrodb-migrations/testing` that exercises `up`, `down`, and `rollbackResolver` without needing a live DynamoDB.

#### 8.1 testMigration

```ts
import { testMigration } from 'electrodb-migrations/testing';
import migration from './migration.js';

testMigration(migration, [
  { input: { id: '1', email: 'a@b' }, expectedV2: { id: '1', email: 'a@b', status: 'active' } },
  { roundTrip: { id: '1', email: 'a@b' } },
  { input: { id: '1', email: 'a@b' }, expectedV2: 'valid' },
]);
```

Types for `input`, `expectedV2`, and `roundTrip` are inferred from `migration.from` and `migration.to` — same pattern ElectroDB uses for entity types — so you get autocomplete on every field.

##### 8.1.1 Forward transform — `{ input, expectedV2 }`

Asserts `up(input)` deep-equals `expectedV2`. The output is also validated against v2's ElectroDB schema, so a mismatched-shape `up()` fails the test even if you didn't assert the offending field.

##### 8.1.2 Round-trip — `{ roundTrip }`

Asserts `down(up(x))` deep-equals `x`. Requires `down` to be defined on the migration. Both directions are schema-validated. This is the cheapest way to make sure post-finalize rollback is actually possible.

##### 8.1.3 Schema-only — `{ input, expectedV2: 'valid' }`

Asserts `up(input)` produces a record valid against v2's schema, without specifying exact values. Use for non-deterministic transforms (e.g. `id: crypto.randomUUID()`).

#### 8.2 testRollbackResolver

```ts
import { testRollbackResolver } from 'electrodb-migrations/testing';

testRollbackResolver(migration, [
  { kind: 'A', v1Original: {...}, v2: {...}, expected: {...} },
  { kind: 'B', v2: {...}, expected: {...} },
  { kind: 'C', v1Original: {...}, expected: null },
]);
```

Each case calls `migration.rollbackResolver(...)` with the supplied `kind`, `v1Original`, and `v2`, and asserts the return value deep-equals `expected`. `expected: null` asserts the resolver chose to delete the primary key. Output is schema-validated against v1.

The harness throws at start if `rollbackResolver` isn't defined on the migration.

#### 8.3 Test-runner integration

Both functions are framework-agnostic — they throw on the first failure and return normally on success. Wrap each call in your runner's `it()` (or equivalent) for proper reporting:

```ts
import { describe, it } from 'vitest';

describe('add-status migration', () => {
  it('passes all cases', () => testMigration(migration, [/* ... */]));
});
```

### 9. Errors

#### 9.1 EDBMigrationError (base)

#### 9.2 EDBMigrationLockHeldError

#### 9.3 EDBMigrationInProgressError

Thrown by the [migration guard](#6-wrap-your-dynamodb-client-with-the-migration-guard) when the app tries to read or write while the lock is held.

The recommended pattern is to surface it as HTTP 503 with `Retry-After` so load balancers and HTTP clients back off automatically:

```ts
import { isMigrationInProgress } from 'electrodb-migrations';

// Example: Express error middleware. Adapt to your HTTP framework.
app.use((err, req, res, next) => {
  if (isMigrationInProgress(err)) {
    res.set('Retry-After', '30'); // pick a value that fits your expected migration runtime
    return res.status(503).json({ error: 'Migration in progress' });
  }
  next(err);
});
```

`isMigrationInProgress(err)` is a duck-typed checker; prefer it over `instanceof EDBMigrationInProgressError`, which is fragile under dual ESM/CJS. The thrown error's `details` field carries lock metadata (the current `runId`, the lock state) if you want to log it.

The framework deliberately does **not** prescribe a `Retry-After` value — your migration's expected runtime is your call.

#### 9.4 EDBRequiresRollbackError

#### 9.5 EDBRollbackNotPossibleError

#### 9.6 EDBRollbackOutOfOrderError

#### 9.7 EDBStaleEntityReadError

#### 9.8 EDBSelfReadInMigrationError

#### 9.9 Reason codes

### 10. Drift detection

#### 10.1 What counts as drift

The framework compares each entity to its last snapshot in `.electrodb-migrations/` and reports any change to the on-disk shape:

- **Attributes** — added, removed, retyped, or with their `required` flag toggled.
- **Primary index** — partition or sort key composition, including field order and any prefix.
- **Secondary indexes (GSIs / LSIs)** — added, removed, or with their key composition changed.

`create` reacts to any of these by scaffolding a migration and bumping `model.version`. Anything outside this list is behavior-only — see [§10.2](#102-what-does-not-count-as-drift-behavior-only-changes).

#### 10.2 What does NOT count as drift (behavior-only changes)

Some entity changes don't alter the on-disk shape and so don't trigger drift:

- **Validators** on attributes.
- **Getters** and other format-time functions.
- **Sparse-index `condition` functions** that decide whether a record participates in a GSI.

These run at read or write time and don't change what's persisted. The framework can't tell from the snapshot whether your behavior change requires existing records to be rewritten — that's your call. If it does, scaffold the migration anyway with `--force`:

```sh
npx electrodb-migrations create --entity User --name normalize-email --force
```

The transform you write decides whether each record needs rewriting; `--force` only unlocks the scaffold step.

#### 10.3 Snapshot storage layout

#### 10.4 Snapshot lifecycle

#### 10.5 Forcing a migration when no drift is detected

### 11. Multi-developer workflow

`.electrodb-migrations/` is committed (per [step 1](#1-initialize)). That gives CI the history it needs to detect drift, but it also means parallel branches that both scaffold a migration on the same entity will collide.

**The collision.** Branches A and B are open at the same time, and both scaffold a User migration:

- Branch A: `20260501-User-add-status` — claims User v1 → v2.
- Branch B: `20260502-User-add-tier` — also claims User v1 → v2.

Each migration folder ships a frozen `v1.ts` (the pre-migration shape) and `v2.ts` (the target shape). When A merges to main, the snapshot in `.electrodb-migrations/` advances to A's User v2. Branch B is now broken in three ways simultaneously:

- B's migration folder claims to start from User v1, but main's User is at v2.
- B's `v1.ts` no longer matches the new "previous" shape (which is A's v2).
- B's `up()` was written assuming the v1 input shape.

CI's [`validate` gate](#412-validate) catches this before merge — but you still have to fix B before it can land.

**The fix.**

1. Rebase the later branch on main.
2. Re-frame the migration to the new starting point:
   ```sh
   npx electrodb-migrations create --regenerate 20260502-User-add-tier
   ```
   The framework keeps your `up()` and `down()` code, rewrites `v1.ts` and `v2.ts` to match the new "previous" shape and the current entity, and prints the new diff.
3. Review the diff and update `up()` if the underlying transform changed (often it didn't — you're just reapplying the same incremental change on top of the new baseline).
4. Commit and push. B now claims User v2 → v3 with internally consistent frozen schemas.

> **Note:**  
> *The same workflow applies to slow-merging PRs and long-lived branches: any time main moves on after you've scaffolded, run `--regenerate` before requesting another review.*

### 12. Lock and runtime internals

#### 12.1 The _migration_lock entity

#### 12.2 The _migrations entity (state log)

#### 12.3 Heartbeat and stale takeover

#### 12.4 The acquire algorithm (conditional-write + verify)

#### 12.5 Pre-migration wait window

#### 12.6 runId tracking

### 13. Migration state machine

#### 13.1 States (pending / applied / finalized / failed / reverted)

#### 13.2 Transitions

#### 13.3 Failed migrations and required rollbacks

#### 13.4 Reverted is terminal

### 14. Multi-entity tables

#### 14.1 Single-table design implications

#### 14.2 Why locks are table-wide today

#### 14.3 Per-entity migration ordering

### 15. Future plans

#### 15.1 Per-entity lock scoping

#### 15.2 Zero-downtime apply

#### 15.3 Additional remote transports

#### 15.4 Entity deletion migrations

#### 15.5 Other ideas

---
