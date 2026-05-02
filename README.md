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

## What it does

You keep a single source-of-truth entity file (e.g. `src/entities/user.ts`). When you change its shape, the framework detects the drift, scaffolds a migration folder with frozen v1/v2 snapshots and a transform stub, and walks the table converting v1 records to v2 records under a global lock. After a bake window where v1 and v2 coexist, you finalize and v1 is deleted.

---

## Quick start

> **Heads up:**  
> *Before going to production, it is **highly** recommended read the [Recommended](#recommended) section.*

### 1. Initialize

```sh
npx electrodb-migrations init
```

Creates:

```
.electrodb-migrations/                # framework-managed state (do not edit/loose)  
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

This writes one snapshot per entity into the frameworks internal state without scaffolding any migration. Skip this for greenfield projects — your first `create` will produce the first snapshot.

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
  ..
});
```

You add `status`. You **don't** have to bump `model.version` — the framework does that for you.

> **Note:**  
> *You are allowed to completely change the entity shape in this step including adding/remove indexes, changing primary index shape, etc. Only the `model.name` and `model.service` must stay the same.*

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

3. Bumps `model.version: '1'` → `model.version: '2'` in `src/entities/user.ts` (the *only* edit it makes to your source).
4. Updates its internal snapshot.
6. Prints the schema diff so you know what `up()` needs to handle:

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

- Acquires the global table lock in migration mode.
- Scans v1 records, runs your `up()` against each, writes v2 records alongside.
- Both versions coexist on disk. ElectroDB's identity stamps mean v1 reads see only v1, v2 reads see only v2.
- Marks the migration `applied`, replaces the global migration lock with an pending release lock.

> **Note:**  
> *Multiple migrations will be applied in sequence, each acquiring and releasing the global lock as needed.*

#### What is the global lock?
The global lock prevents concurrent migrations and can be easly leveraged to prevent app traffic from hitting you database during migrations, which is highly recommended. More on that in the [Recommended](#recommended) section below.

#### What is the pending release lock after a successful migration?
The pending release lock is a mechanism that ensures that your server code is in sync with the shape of the data during the migration process. So it the typical process would be through these phases:
1. Start migration using `apply`
1. During migration, the global migration lock is held, which blocks all traffic to the database.
1. After successful migration, the global pending release lock is held, which still blocks all traffic to the database.
1. Then you deploy your code that is compatible with the new schema.
1. After deployment, you release the lock using `release` command, which allows traffic to flow to the database again. 


### 7. Deploy your code, then release

Deploy the version of your app that uses the new entity shape. Once it's live and healthy:

```sh
npx electrodb-migrations release
```

The pending release lock is cleared. Traffic flows.

### 8. Finalize

After a bake window where you're satisfied nothing is broken, finalize the migration:

```sh
npx electrodb-migrations finalize --entity User --name add-status
# OR
npx electrodb-migrations finalize --all
```

Deletes the v1 records. Marks the migration `finalized`. Permanent.

> **Note:**  
> *Nothing forces you to finalize a migration, you can easly keep the older data on disk for months. It strongly depends on you use case if you need to optimize DynamoDB storage cost and performance AND which behaviour you need on rollbacks.*
---

## Recommended

The quick start gets you running. But it is highly recommended to apply the following practices in production to avoid silent corruption and bad merges and improve performance during the migration process.

### 1. Wrap your DynamoDB client with the migration guard

While a migration is running, has failed, or is holding a pending release lock, you do **not** want app traffic hitting the database. Data consistency is not guaranteed during these states, there is no live caching of database writes in the current version, meaning the migrations **has** down time.

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
> *The migration runner first aquires the lock and then waits 15 seconds before starting the actual migration.  
> All those settings can be configured, see [detailed docs](#docs) for more info.*

### 2. Block bad merges in CI

Run this in your CI pipeline as a pre-merge or pre-deploy gate:

```sh
npx electrodb-migrations validate
```

Among other things it exits non-zero if any entity has drift without a scaffolded migration. Catches "developer edited an entity but didn't run `create`" before that change ever reaches a production table.

It checks:
- If there is any drift between the current entity and the last snapshot.
- If there is a migration scaffolded for that drift.
- If the enetity version is in sync with the migrations version.
- If the migrations start with version 1 and then increment by 1 for each migration (no resets or skips).
    - if you deleted older migrations which are no longer needed, you have to specify the starting version in the config per entity, e.g. `User: 5` if your latest migration for User is v5. More on that in the [detailed docs](#docs).

### 3. Performance - running migration on AWS
Per quickstart the framework runs locally (e.g. CI). But the framework is designed to run migrations on AWS. This is especially useful for large datasets that would take a long time to migrate locally.

The easiest way to run migrations is via AWS Lambda, but it has its limitations (max 15 minutes execution time, cold starts, etc.). For long-running migrations, it is recommended to run them on an EC2 instance or a container service like ECS or EKS.

#### AWS Lambda approach

Create a migration handler function using the framework's helper:

```ts// src/migrationHandler.ts
import { createLambdaMigrationHandler } from 'electrodb-migrations';

export const handler = createLambdaMigrationHandler({
  apiKey: process.env.MIGRATIONS_API_KEY, // set this env var to protect your migration endpoint
  table: 'app-table',
  migrations: 'src/migrations',
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

> **Note:**  
> *All cli commands that interact with the database (apply, release, finalize, rollback) can be run with the `--remote` flag to execute them on AWS instead of locally. This way your CLI does not need direct access to the database and can leverage the cloud for execution.*

---
