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
- [Concepts](#concepts)
- [Detailed docs](#detailed-docs)

---

## What it does

You keep a single source-of-truth entity file (e.g. `src/entities/user.ts`). When you change its shape, the framework detects the drift, scaffolds a migration folder with frozen v1/v2 snapshots and a transform stub, and walks the table converting v1 records to v2 records under a global lock. After a bake window where v1 and v2 coexist, you finalize and v1 is deleted.

---

## Quick start

> **Heads up:**  
> *Before going to production, it is **highly** recommended to read the [Recommended](#recommended) section.*

### 1. Initialize

```sh
npx electrodb-migrations init
```

Creates:

```
.electrodb-migrations/                # framework-managed state (do not edit or delete)
src/migrations/                       # actual migrations (edit these)
electrodb-migrations.config.ts        # framework configuration
```

The config is a `.ts` file so you can dynamically set the table name from env vars, SST `Resource` references, etc.

```ts
// electrodb-migrations.config.ts
import { defineConfig } from 'electrodb-migrations';

export default defineConfig({
  entities: 'src/entities',         // scanned recursively - pass a list for explicit control
  // optional:
  table: 'app-table',
  migrations: 'src/migrations',
});
```

> *Also supports config file extensions: `.js`, `.mjs`, `.cjs`, `.json`.*


### 2. Baseline an existing project

If your entities already exist in production, snapshot them so the framework knows the current shape is the starting point:

```sh
npx electrodb-migrations baseline
```

This writes one snapshot per entity into the framework's internal state without scaffolding any migration. Skip this for greenfield projects — your first `create` will produce the first snapshot.

### 3. Edit your entity

```ts
// src/entities/user.ts
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

You add `status`. You **don't** have to bump `model.version` — the framework does that for you.

> **Note:**  
> *You are allowed to completely change the entity shape in this step, including adding or removing indexes, changing the primary index shape, etc. Only `model.entity` and `model.service` must stay the same.*

### 4. Scaffold the migration

```sh
npx electrodb-migrations create --entity User --name add-status
```

> **Note:**  
> *The framework only detects shape drift (attributes, keys, indexes). Behavior-only changes (validators, getters, sparse-index `condition` functions) don't trigger drift; if you know your behavior change needs data work, scaffold with `create --force` anyway.*

The framework:

1. Generates the migration folder:

   ```
   migrations/20260501083000-User-add-status/
   ├── v1.ts              # frozen schema-only copy of the previous version
   ├── v2.ts              # frozen schema-only copy of the new version
   └── migration.ts       # actual migration with an up() stub for you to fill in
   ```

2. Bumps `model.version: '1'` → `model.version: '2'` in `src/entities/user.ts` (the *only* edit it makes to your source).
3. Updates its internal snapshot.
4. Prints the schema diff so you know what `up()` needs to handle:

   ```
   User: v1 → v2
     + status: 'active' | 'inactive'  (required)  ⚠ NEEDS DEFAULT IN up()
   ```

### 5. Fill in the transform

```ts
// migrations/20260501083000-add-status/migration.ts
import { defineMigration } from 'electrodb-migrations';
import { User as UserV1 } from './v1.js';
import { User as UserV2 } from './v2.js';

export default defineMigration({
  id: '20260501083000-add-status',
  entityName: 'User',
  from: UserV1,
  to: UserV2,
  up: async (user) => ({
    ...user,
    status: 'active' as const,
  }),
  // down: async (user) => { const { status: _s, ...v1 } = user; return v1; },
});
```

`up` is required, `down` is optional but required for post-finalize rollback.

### 6. Apply

```sh
npx electrodb-migrations apply
```

What happens:

- Acquires the **migration lock** on the table — blocks concurrent migration runners and, if you've wired the guard wrapper, app traffic too.
- Scans v1 records, runs your `up()` against each, writes v2 records alongside.
- Both versions coexist on disk. ElectroDB's identity stamps mean v1 reads see only v1, v2 reads see only v2.
- On success, marks the migration `applied` and transitions the lock to **release mode** — still gates traffic, until you call `release` after deploying your new code.

> **Note:**  
> *Multiple migrations will be applied in sequence, each acquiring and releasing the lock as needed.*

> **Want details on the lock?**  
> *See [Concepts → Locks](#locks-migration-and-release-modes) for the full state machine and why the release-mode handoff exists.*


### 7. Deploy your code, then release

Deploy the version of your app that uses the new entity shape. Once it's live and healthy:

```sh
npx electrodb-migrations release
```

The release lock is cleared. Traffic flows.

### 8. Finalize

After a bake window where you're satisfied nothing is broken, finalize the migration:

```sh
npx electrodb-migrations finalize 20260501083000-User-add-status
# OR
npx electrodb-migrations finalize --all
```

Deletes the v1 records. Marks the migration `finalized`. Permanent.

> **Note:**  
> *Nothing forces you to finalize a migration — you can keep the older data on disk for months. It depends on your use case whether you need to optimize DynamoDB storage cost and performance, and on which behavior you want on rollbacks.*
---

## Recommended

The quick start gets you running. But it is highly recommended to apply the following practices in production to avoid silent corruption and bad merges and improve performance during the migration process.

### 1. Wrap your DynamoDB client with the migration guard

While a migration is running, has failed, or is in release mode, you do **not** want app traffic hitting the database. Data consistency is not guaranteed during these states — there is no live caching of database writes in the current version, meaning the migration **has** downtime.

> **Note:**  
> *Zero downtime might be possible in the future, see [Future plans](#future-plans).*

The guard wrapper is a thin DynamoDB client wrapper that intercepts every call and throws `MigrationInProgressError` instead of going to the wire.

```ts
import { wrapClientWithMigrationGuard, createMigrationsClient } from 'electrodb-migrations';

const client = new DynamoDBClient(...); // OR DynamoDBDocumentClient

const migrate = createMigrationsClient({ client: client, table });

const guarded = wrapClientWithMigrationGuard({
  client: client,
  migrationsClient: migrate,
});

// Use `guarded` for every Entity (and Service) in your app:
const User = new Entity(userSchema, { client: guarded, table });
```

The migration runner uses the unwrapped client and keeps working while the wrapper rejects app traffic. Cost is one cached `GetItem` per five seconds per process at most — negligible compared to silent corruption from a stale schema reading new-format data.

> **Why is caching for five seconds safe?**  
> *The migration runner first acquires the lock and then waits 15 seconds before starting the actual migration.  
> All those settings can be configured, see [detailed docs](#detailed-docs) for more info.*

### 2. Block bad merges in CI

Run this in your CI pipeline as a pre-merge or pre-deploy gate:

```sh
npx electrodb-migrations validate
```

Among other things it exits non-zero if any entity has drift without a scaffolded migration. Catches "developer edited an entity but didn't run `create`" before that change ever reaches a production table.

It checks:
- Whether there is any drift between the current entity and the last snapshot.
- Whether there is a migration scaffolded for that drift.
- Whether the entity version is in sync with the migrations version.
- Whether the migrations start at version 1 and increment by 1 for each migration (no resets or skips).
    - If you deleted older migrations that are no longer needed, you have to specify the starting version in the config per entity, e.g. `User: 5` if your latest migration for User is v5. More on that in the [detailed docs](#detailed-docs).

### 3. Performance - running migration on AWS
Per quickstart the framework runs locally (e.g. CI). But the framework is designed to run migrations on AWS. This is especially useful for large datasets that would take a long time to migrate locally.

The easiest way to run migrations is via AWS Lambda, but it has its limitations (max 15 minutes execution time, cold starts, etc.). For long-running migrations, it is recommended to run them on an EC2 instance or a container service like ECS or EKS.

#### 3.1 AWS Lambda approach

Create a migration handler function using the framework's helper:

```ts
// src/migrationHandler.ts
import { createLambdaMigrationHandler } from 'electrodb-migrations';
import migrations from './migrations/index.js';
import { Resource } from 'sst';

export const handler = createLambdaMigrationHandler({
  apiKey: process.env.MIGRATIONS_API_KEY, // set this env var to protect your migration endpoint
  table: Resource.AppTable.name,          // resolved in the Lambda environment
  migrations,                             // statically imported so the bundler picks it up
});
```

Then in the `electrodb-migrations.config.ts` file, add the following configuration:

```ts
export default defineConfig({
  // ... other config options
  remote: {
    url: process.env.MIGRATIONS_REMOTE_URL, // set this env var to your lambda endpoint
    apiKey: process.env.MIGRATIONS_API_KEY, // set this env var to protect your migration endpoint
  },
});
```

If you now run `npx electrodb-migrations apply --remote`, the framework will send the migration commands to your Lambda function, which will execute them in the cloud. 

**Important Notes:**

- It does use one function invocation per migration in sequence order so each single migration has 15 minutes to complete. For most use cases this is sufficient, but do your own due diligence on the expected runtime of your migrations.
- Make sure you table has sufficient read/write capacity to handle the migration workload, especially if you have a large dataset. Consider using on-demand capacity or temporarily increasing provisioned capacity during the migration.
- All CLI commands that interact with the database (apply, release, finalize, rollback) can be run with the `--remote` flag to execute them on AWS instead of locally. This way your CLI does not need direct access to the database and can leverage the cloud for execution.

#### 3.2 Long-running server approach
For long-running migrations that exceed Lambda's limits, you can run the framework inside a long-running Node process on an EC2 instance or a container in ECS/EKS. The framework does not provide a server implementation, but you can easily build one using the migrations client. See [detailed docs](#running-on-a-long-running-migration-server) for more information.

---

## Concepts

### Locks: migration and release modes

The framework holds a single global lock on your table while a migration is in progress. The lock has two distinct states.

**Migration mode.** Held while `apply` is actively scanning, transforming, and writing v2 records. Concurrent migration runners are blocked. If you've wired the [guard wrapper](#1-wrap-your-dynamodb-client-with-the-migration-guard), app traffic is rejected for the duration.

**Release mode.** After `apply` finishes successfully, the lock automatically transitions to release mode. The migration is on disk, but your application code is presumably still on the old shape. The release-mode lock keeps app traffic gated until you confirm the new code is deployed and call `release`.

The typical sequence:

1. Run `apply`. Lock enters migration mode.
2. `apply` completes. Lock transitions to release mode.
3. Deploy the version of your app that uses the new entity shape.
4. Run `release`. Lock cleared. Traffic resumes.

This two-state design lets you run database migrations and code deploys *in the order that makes sense for each*, without leaving a window where the deployed code expects a shape the data hasn't reached yet.

**Manual recovery (`unlock`).** If a runner dies mid-migration — process killed, ECS task terminated without graceful shutdown, server crashed — the lock row stays held until the stale-takeover threshold expires (a few hours by default). To skip the wait, the operator can clear the lock manually via the CLI's `unlock` command. Doing so flips any in-progress migration to `failed`, which forces the next `apply` to refuse and demand a `rollback` first — partial writes from the dead runner must not be silently treated as a clean slate.

> **Warning:**  
> *`unlock` assumes no runner is actually alive. If a runner is still working when you unlock, you will corrupt the migration state. The CLI prompts for confirmation by default and will tell you which runId currently holds the lock.*

### Rollback

Rollback is gated by the same global lock as `apply`. It always takes a specific migration id and the framework refuses to roll back anything other than the **head** — the most recent applied (and not yet reverted) migration on that entity. No skipping, no cascades. To roll back further, roll back the head, then the new head, and so on.

```sh
npx electrodb-migrations rollback 20260501083000-User-add-status
# or against the configured remote runner
npx electrodb-migrations rollback 20260501083000-User-add-status --remote
```

The lock is symmetric with `apply`: rollback enters migration mode, then transitions to release mode on success. After deploying the old code, call `release` to clear the lock.

What happens on disk depends on **where in the lifecycle** the migration is — specifically, whether `release` has already been called. That's the point at which app traffic could have written fresh v2 records that have no v1 mirror.

#### Case 1 — Rollback before `release` (lock still in release mode)

Every v2 record on disk is a transformed copy of a v1 record; v1 is intact. The framework deletes the v2 records. `down` is **not** required. Fully lossless.

> **Note:**  
> *This applies also for failed migrations that never made it to release mode.*

#### Case 2 — Rollback after `release`, before `finalize` (lock cleared, app live)

The app has been writing fresh v2 records. Some v2 records have no v1 mirror. This case has two options:

##### Option A (the default)
- With `down` defined: the framework runs `down(v2) → v1` against every v2 record (fresh and transformed alike), in detail:
    - delete all existing v1 versions of that entity
    - writes the recovered v1 through the `down` function
    - deletes v2
- Without `down`: the framework refuses with `RollbackNotPossibleError({ reason: 'no-down-fn' })`

##### Option B
- must be explicitly opted into with `--dangerously-discard-new-data`
- The framework deletes every v2 record, including fresh ones with no v1 mirror

#### Case 3 — Rollback after `finalize`

The v1 records are already gone. `down` is **required**; without it the framework throws `RollbackNotPossibleError({ reason: 'no-down-fn' })`. Algorithm is identical to Case 2 with `down`.

#### Refusal cases

- A newer applied migration exists for the same entity → `RollbackOutOfOrderError`.
- The migration is `pending` or already `reverted` → friendly no-op message.
- Case 2 without `down` and without `--dangerously-discard-new-data` → `RollbackNotPossibleError({ reason: 'no-down-fn' })`.
- Case 3 without `down` → `RollbackNotPossibleError({ reason: 'no-down-fn' })`.

> **Note:**  
> *If you have multiple unfinalized migrations stacked on top of each other, each one carries its own gap window from when it was released. The head rule keeps each rollback to one decision at a time — the framework does not cascade.*

---

## Detailed docs

Deep dives on the parts of the framework you don't need on day one.

### Running on a long-running migration server

The Lambda approach in [Recommended → Performance](#3-performance---running-migration-on-aws) is the simplest path, but it's bounded by Lambda's 15-minute execution limit. For large tables run the framework inside a long-running Node process — typically an ECS task, an EC2 instance, or any container.

The framework does not ship a server. It gives you a migrations client; you decide how to receive commands and route them to it.

#### What your server process does

Inside your handler you import the migrations and build a single migrations client. Reuse it across requests; it caches the lock state and other metadata.

```ts
// src/migrationServer.ts
import { createMigrationsClient } from 'electrodb-migrations';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import migrations from './migrations/index.js';

const client = new DynamoDBClient({});
const migrate = createMigrationsClient({
  client,
  table: 'app-table',
  migrations,
});
```

#### Invoking the migrations client

The client exposes one method per CLI command. Each one acquires the lock, does its work, and releases or transitions it as appropriate.

`apply`, `rollback`, and `finalize` can take long enough to outlast any HTTP socket in front of your server (ALB defaults to 60s, API Gateway to 30s). For an HTTP handler, use the background pair so the request can return immediately with a `runId` that the caller polls:

```ts
// kick off in the background; resolves once the run is registered, not when it finishes
const { runId } = await migrate.runInBackground({ command: 'apply' });

// snapshot the current state of a run (poll this from your `status` endpoint)
const snapshot = await migrate.getRunStatus(runId);
// { status: 'running' | 'completed' | 'failed', command, progress?, result?, error? }
```

`release` is fast (a single conditional update) and stays blocking:

```ts
await migrate.release();                                           // returns { released: true }
```

Blocking variants (`migrate.apply()`, `migrate.rollback(id)`, `migrate.finalize(id)`) are still available — the local CLI uses them directly. Use them when you control the caller and don't need a status channel.

Errors thrown by these methods are instances of `ElectroDBMigrationError`. The most common ones to surface to the caller:

- `MigrationLockHeldError` — another runner holds the lock.
- `RequiresRollbackError` — a previous `apply` failed mid-run; the head migration must be rolled back before any new `apply`.
- `RollbackNotPossibleError` — `down` is missing in a case that requires it (see [Concepts → Rollback](#rollback)).
- `RollbackOutOfOrderError` — the requested migration is not the head.

Errors are split into two categories: **start errors** (validation, lock held, no migrations to run) are thrown synchronously by `runInBackground` before a `runId` is issued. **Run errors** (failures during execution) surface on the snapshot returned by `getRunStatus` as `{ status: 'failed', error: { code, message, details } }`.

#### HTTP wire contract for `--remote`

If you want the local CLI's `--remote` flag to drive your server, your endpoint has to accept the contract the CLI sends. Any transport works (HTTP, an SQS-fronted worker, an ECS RunTask invocation) — but `--remote` itself is HTTPS and posts a single shape:

```
POST <remote.url>
X-Api-Key: <remote.apiKey>
Content-Type: application/json

{ "command": "<apply|rollback|finalize|release|status|unlock>", "args": { ... } }
```

The contract is **async**: `apply`, `rollback`, and `finalize` start the work in the background and return a `runId` immediately. The CLI then polls `status` until the run reaches a terminal state. `release` and `status` are synchronous.

Per-command body and success response:

| command    | sync/async | args                                                | response (success)                                           |
|------------|------------|-----------------------------------------------------|--------------------------------------------------------------|
| `apply`    | async      | `{}`                                                | `{ runId: string, status: 'started' }`                       |
| `rollback` | async      | `{ migrationId: string, discardNewData?: boolean }` | `{ runId: string, status: 'started' }`                       |
| `finalize` | async      | `{ migrationId?: string, all?: boolean }`           | `{ runId: string, status: 'started' }`                       |
| `release`  | sync       | `{}`                                                | `{ released: true }`                                         |
| `status`   | sync       | `{ runId: string }`                                 | see *status response* below                                  |
| `unlock`   | sync       | `{ runId?: string }`                                | `{ unlocked: true, markedFailed: string[] }`                 |

Status response shape:

```json
{
  "status": "running" | "completed" | "failed",
  "command": "apply" | "rollback" | "finalize",
  "progress": {
    "phase": "scanning" | "transforming" | "writing" | "deleting",
    "currentMigrationId": "20260501083000-User-add-status",
    "current": 200,
    "total": 1000,
    "elapsedMs": 30000
  },
  "result": { "applied": ["20260501083000-User-add-status"] },
  "error": { "code": "RollbackNotPossibleError", "message": "...", "details": { } }
}
```

`progress` is present while `status` is `running`. `result` is present once `status` is `completed`. `error` is present once `status` is `failed`.

If a `start` request fails before a run is registered (lock held, validation error, no migrations to run), the response is the synchronous error shape — no `runId` is issued:

```json
{ "error": { "code": "MigrationLockHeldError", "message": "...", "details": { } } }
```

Your handler validates the api key, switches on `command`, and routes to `migrate.runInBackground(...)` for the async commands or `migrate.getRunStatus(...)` for `status`. The framework deliberately does not prescribe Express, Fastify, or Koa — pick what fits your stack.

#### Operational notes

The process must stay up for the duration of an `apply` or `rollback`. The framework holds the lock with periodic heartbeats; if the process dies mid-run, the lock falls back to its stale-takeover threshold (a few hours by default) before another runner can take over. Configure the heartbeat interval and stale threshold in `electrodb-migrations.config.ts`.

If a task dies mid-migration and you don't want to wait out the stale-takeover threshold, the CLI's `unlock` command clears the lock and marks any in-progress migration as `failed`. Read its full docs before reaching for it — used incorrectly, it will corrupt migration state.

---
