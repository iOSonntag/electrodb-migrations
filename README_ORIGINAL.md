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

### 1. Initialize

```sh
npx electrodb-migrations init
```

Creates:

```
electrodb-migrations.config.ts        # framework configuration
.electrodb-migrations/                # framework-managed state (don't edit - don't loose it)  
src/migrations/                       # actual migrations (edit these)
```

The config is a `.ts` file so you can dynamically set the table name from env vars, SST `Resource` references, etc.

```ts
// electrodb-migrations.config.ts
import { defineConfig } from 'electrodb-migrations';

export default defineConfig({
  entities: 'src/entities',         // scanned recursively for entities
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

This writes one snapshot per entity (`snapshots/User.json`, etc.) without scaffolding any migration. Skip this for greenfield projects — your first `create` will produce the first snapshot.

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

### 4. Scaffold the migration

```sh
npx electrodb-migrations create --entity User --name add-status
```

The framework:

1. Detects drift between `src/entities/user.ts` and its internal snapshot.
2. Generates the migration folder:

   ```
   migrations/20260501083000-add-status/
   ├── v1.ts              # frozen schema-only copy of the previous version
   ├── v2.ts              # frozen schema-only copy of the new version
   └── migration.ts       # defineMigration call with an up() stub for you to fill in
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

`up` is required. `down` is optional but required for post-finalize rollback.

### 6. Apply

```sh
npx electrodb-migrations apply
```

What happens:

- Acquires the global table lock in migration mode.
- Scans v1 records, runs your `up()` against each, writes v2 records alongside.
- Both versions coexist on disk. ElectroDB's identity stamps mean v1 reads see only v1, v2 reads see only v2.
- Marks the migration `applied`, replaces the global migration lock with an access lock.

#### What is the global lock?
The global lock prevents concurrent migrations but it also can be easly leveraged to prevent app traffic from hitting you database during migrations. More on that in the "Guard wrapper" section below.

#### What is the access lock after a successful migration?
The access lock is a mechanism that ensures that your server code is in sync with the shape of the data during the migration process. So it the typical process would be through these phases:
1. Start migration using `apply()`
1. During migration, the global migration lock is held, which blocks all traffic to the database (if configured).
1. After successful migration, the global access lock is held, which still blocks all traffic to the database (if configured).
1. Then you deploy your code that is compatible with the new schema.
1. After deployment, you release the lock using `release` command, which allows traffic to flow to the database again. 



### 7. Deploy your code, then release

Deploy the version of your app that uses the new entity shape. Once it's live and healthy:

```sh
npx electrodb-migrations release add-status
```

The deployment block clears. The guard wrapper stops throwing. Traffic flows.

### 8. Finalize

After a bake window where you're satisfied nothing reads v1:

```sh
npx electrodb-migrations finalize
```

Deletes the v1 records. Marks the migration `finalized`. Permanent.

---

## Mental model

Three concurrent timelines:

```
v1 records on disk     ███████████████░░░░░░░░░░░░░░░░░░
v2 records on disk                    ███████████████████████████████
status row                 (none)  →  pending  →  applied   →   finalized
                                       ↑           ↑              ↑
                                      apply()   apply done    finalize()

                                                 |--- bake window ---|
```

### The 5-state machine

```
              apply()                  finalize()
   (none) ──────────► pending ──────► applied ──────► finalized   (terminal)
                          │              │                │
                          │              │ (apply fails)  │
                          ▼              ▼                │
                       failed ◄────────────────           │
                          │                               │
                          │ rollback()                    │ rollback()
                          ▼                               ▼
                       reverted                       reverted     (terminal)
```

- **`pending`** — pre-written at the start of `apply` so failures land on a real row.
- **`applied`** — `up()` finished; both v1 and v2 exist. Bake window starts here.
- **`finalized`** — v1 rows deleted. Permanent.
- **`failed`** — `apply` threw mid-loop. You **must** rollback before re-applying.
- **`reverted`** — terminal. Re-applying a reverted migration is intentionally hard.

### Pre- vs. post-finalize rollback

- **Pre-finalize** (status: `applied` or `failed`) — delete v2 records, leave v1. Cheap, doesn't need `down()`.
- **Post-finalize** (status: `finalized`) — scan v2, run `down()` to recreate v1, delete v2. Requires `down()`.

### `apply` and `rollback` leave a deployment block by default

The default workflow is **migrate → deploy → release**. Both `apply` and `rollback` succeed without auto-clearing the deployment block; you release it explicitly with `electrodb-migrations release <id>`.

This decouples two distinct concerns:

- **Runner mutex** — concurrency between migration runners. Released as soon as `apply` returns; another migration can run during your deploy.
- **Traffic gate** — keeps the guard wrapper rejecting app calls until you confirm the new code is live.

If you don't want the gate, pass `--auto-release` to `apply` or `rollback`.

---

## Project layout

```
your-project/
├── electrodb-migrations.config.ts                 ← framework configuration
├── src/
│   └── entities/                                  ← scanned by entitiesDir
│       ├── user.ts                                ← your source of truth
│       └── billing/
│           └── invoice.ts                         ← subdirectories are fine
├── .electrodb-migrations/
│   └── snapshots/
│       ├── User.json                              ← canonical schema + fingerprint
│       └── Invoice.json
└── migrations/
    ├── index.ts                                   ← auto-generated registry
    └── 20260501083000-add-status/
        ├── v1.ts                                  ← frozen schema (regenerated)
        ├── v2.ts                                  ← frozen schema (regenerated)
        └── migration.ts                           ← your up()/down() goes here
```

Conventions:

- One folder per migration, named `<utcTimestamp>-<kebab-slug>`. Lex-sortable, human-readable.
- `migrations/index.ts` is auto-generated. Don't edit it.
- `migrations/<id>/v1.ts` and `v2.ts` are auto-generated. Don't edit them.
- `migrations/<id>/migration.ts` is yours. Edit `up()` and `down()`.
- Snapshots are auto-generated. Don't edit them; use `accept` if you need to bump them past current drift without scaffolding.
- The framework only edits one thing in `src/entities/`: bumps `model.version` during `create`.

---

## Schema-only history (important contract)

The auto-generated `v1.ts` and `v2.ts` files inside each migration folder are **schema-only**. The framework drops:

- `validate` functions
- `get` / `set` transforms
- `default` *functions* (literal defaults are kept)
- `condition` (sparse-index predicates)
- `watch`
- Custom-type imports — `CustomAttributeType<Money>()` round-trips as `'any'`, the same opaque marker ElectroDB sees at runtime.

Regenerated files import only `electrodb`. They're self-contained; refactoring your `src/` folder later won't break historical migrations.

This is correct on purpose. **`migration.from` is read-only and only feeds items to your `up()` body** — it doesn't need validators or getters running. The current entity (`migration.to`) is generated *the same way* (schema-only) for symmetry with the historical view.

If your `up()` needs validation logic or custom typing for items, import them in `migration.ts` directly:

```ts
import type { Money } from '@company/types';
import { isValidEmail } from '../../src/validators.js';

export default defineMigration({
  // ...
  up: async (user) => {
    if (!isValidEmail(user.email)) throw new Error(`bad email: ${user.email}`);
    const amount = user.amount as Money;
    return { ...user, amount };
  },
});
```

You own these imports — they live in `migration.ts`, not in the generated frozen entities.

### Behavior-only changes (the corner case)

Drift detection hashes shape, not behavior. So changing a `condition` function on a sparse index, or rewriting a `default: () => ...` function, *won't* trigger drift even though it might semantically warrant a migration (e.g. re-evaluating which items are indexed under the new condition).

When you know you need a migration despite no shape drift:

```sh
npx electrodb-migrations create --entity User --name reindex-condition --force
```

`--force` scaffolds a migration even when fingerprints match. The snapshot is bumped as if drift existed.

---

## CLI reference

All commands accept `--config <path>`, `--table <name>`, `--region <name>`, `--profile <name>`, `--json`. Apply/finalize/rollback also accept `--dry-run` and `--yes`.

| Command | Purpose |
|---|---|
| `init` | Create `electrodb-migrations.config.ts` and the directory layout |
| `baseline` | Snapshot current entities without scaffolding any migration. For brownfield onboarding. |
| `status` | Print applied / pending / drift per entity |
| `status --strict` | Same, but exits non-zero on drift without a scaffolded migration. CI-ready. |
| `diff` | Show schema diff between current entity and last snapshot. Writes nothing. |
| `create --entity <Name> --name <slug>` | Scaffold a migration from drift. `--force` to scaffold without drift. |
| `plan` | Dry-run apply: count items, run `up()` on a sample, estimate cost. |
| `apply` | Run pending migrations (oldest first). `--auto-release` to skip the deployment block. |
| `finalize` | Finalize the oldest pending. `finalize <id>` for a specific one (must be next in line). `finalize --all` for everything pending. |
| `rollback` | Undo the most recent applied-but-not-finalized migration. `--auto-release` to skip the deployment block. |
| `release <id>` | Release the deployment block left by `apply` or `rollback`. `--all` to release every active block. |
| `accept` | Treat current drift as a no-op; bump snapshot without scaffolding. |
| `reconcile-state` | Rebuild the aggregate state row from per-migration history. Operator recovery tool. |

### CI integration

Drop this into a CI job before deploy:

```sh
npx electrodb-migrations status --strict
```

It exits non-zero if any entity has drift without a scaffolded migration. This catches "developer edited an entity but didn't run `create`" before the change reaches production.

For the deploy job itself, the table name comes from whatever your config file evaluates to in this environment — SST `Resource`, env var, etc. The CLI doesn't care how the value gets there, only that the config can compute it:

```sh
# SST: sst shell injects credentials and evaluates Resource references
sst shell -- npx electrodb-migrations apply --yes
sst shell -- ./deploy.sh
sst shell -- npx electrodb-migrations release --all --yes
sst shell -- npx electrodb-migrations finalize --all --yes  # (later, after bake)

# CDK / Terraform / plain AWS: export the table name first
export APP_TABLE_NAME=$(aws cloudformation describe-stacks --query '...' --output text)
npx electrodb-migrations apply --yes
./deploy.sh
npx electrodb-migrations release --all --yes
npx electrodb-migrations finalize --all --yes               # (later, after bake)

# One-off against a different table (overrides the config)
npx electrodb-migrations status --table app-staging-table
```

---

## Boot-time check

Refuse to start your app if expected migrations haven't run:

```ts
import { createMigrationsClient } from 'electrodb-migrations';
import migrations from './migrations/index.js';

const migrate = createMigrationsClient({ client: docClient, table });

await migrate.ensureApplied({
  migrations,
  mode: process.env.NODE_ENV === 'production' ? 'verify' : 'strict',
});
```

- **`verify`** — passes if every expected migration is `applied` or `finalized`. One DDB read at boot.
- **`strict`** — additionally checks that the stored fingerprint matches the current entity's fingerprint. Catches "I edited an entity but forgot to scaffold a migration" the moment the dev server boots. Use in development.

---

## Guard wrapper (defending app traffic)

While a migration is running, has failed, or has a deployment block active, you don't want app traffic hitting the table. The guard wrapper is a DDB client wrapper that intercepts every `.send()` call:

```ts
import { wrapClientWithMigrationGuard } from 'electrodb-migrations';

const guarded = wrapClientWithMigrationGuard({
  client: raw,                 // DynamoDBClient OR DynamoDBDocumentClient
  migrationsClient: migrate,
  cacheTtlMs: 1000,            // optional, default 1s
  blockMode: 'all',            // optional, 'all' | 'writes-only', default 'all'
  failureMode: 'closed',       // optional, 'closed' | 'open', default 'closed'
});

// Use `guarded` for every entity in your app:
const User = new Entity(userSchema, { client: guarded, table });
```

When blocked, `.send()` throws `MigrationInProgressError` instead of going to the wire. The migration runner uses the unwrapped client so it can keep operating while the wrapper rejects app traffic.

### Guard options

- **`cacheTtlMs`** — TTL on the guard-state read. Lower = fresher, higher = cheaper. Default 1s, which is well below the runner's `acquireWaitMs` (default 10s) so a fresh acquire is invisible to readers by the time it commits.
- **`blockMode: 'all'`** — block reads and writes. Default. Safest for most apps.
- **`blockMode: 'writes-only'`** — let reads through, block writes. Use if your app is read-heavy and reads can tolerate stale data during a migration window.
- **`failureMode: 'closed'`** — if the guard fetch itself fails, treat as blocked. Default.
- **`failureMode: 'open'`** — if the guard fetch fails, let traffic through. Less safe but useful if the guard is on a hot path and DDB hiccups.

### ElectroDB wraps thrown errors

When you call `Entity.method().go()`, ElectroDB catches anything thrown by the SDK and re-throws as `ElectroError` with the original as `cause`. So when the guard fires through ElectroDB, your app sees:

```
ElectroError: Error thrown by DynamoDB client: "Migration in progress (locked)"
  └── cause: MigrationInProgressError
```

To detect a migration-in-progress error reliably, walk the cause chain:

```ts
const isMigrationInProgress = (err: unknown): boolean => {
  let cur: any = err;
  while (cur) {
    if (cur instanceof MigrationInProgressError) return true;
    cur = cur.cause;
  }
  return false;
};
```

For raw AWS SDK calls (no ElectroDB wrapping), the error surfaces directly.

### Express / Fastify integration

There's no built-in HTTP middleware. Convert to 503 in a one-liner:

```ts
app.use((err, req, res, next) => {
  let cur = err;
  while (cur) {
    if (cur instanceof MigrationInProgressError) {
      return res.status(503)
        .set('Retry-After', '30')
        .json({ error: 'migration-in-progress', reasons: cur.reasons ?? [cur.reason] });
    }
    cur = cur.cause;
  }
  next(err);
});
```



### Entity discovery — folder, not registry

`entitiesDir` is scanned recursively. Every `.ts`/`.js` file is dynamically imported, every export checked with `value instanceof Entity`. Each Entity is registered under its `model.entity` (e.g. `User`), which becomes the snapshot filename (`snapshots/User.json`).

You don't list entities anywhere. Adding a new one is just creating the file. Renaming one means renaming `model.entity` (the framework treats this as drift on the old name + a new entity on the new name — `accept` or `create` lets you bridge it).

What gets skipped: `*.test.ts`, `*.spec.ts`, `*.d.ts`, `node_modules`, files that contain no Entity exports. What errors out: a file that throws on import (with the file path in the message), or two entities resolving to the same `model.entity` (with both file paths in the message).

If the convention doesn't fit, you can pin an explicit list instead:

```ts
export default defineConfig({
  entities: [
    { path: 'src/entities/user.ts' },
    { path: 'src/entities/billing/invoice.ts' },
  ],
  table: process.env.APP_TABLE_NAME!,
});
```

`entitiesDir` is the documented pattern; explicit `entities[]` is for the rare project that needs precise control.

### Custom DDB client (optional)

By default the CLI builds a `DynamoDBClient` from `--region`/`--profile` or the standard AWS credentials chain. Inside `sst shell`, AWS credentials are already in the env and this Just Works. Override only if you need a custom endpoint (DDB Local, etc.) or non-default retry config:

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export default defineConfig({
  entitiesDir: 'src/entities',
  table: 'app-table',
  client: () => new DynamoDBClient({
    endpoint: 'http://localhost:8000',
    region: 'us-east-1',
  }),
});
```

---

## Tips and tricks

### Always wire `ensureApplied` at boot

Pair `verify` mode in production with `strict` mode in development. The dev-mode strict check turns "I forgot to run `create`" from a runtime mystery into a startup-time error.

### Always wire the guard wrapper

The cost is one cached GetItem per `cacheTtlMs` window per process. Negligible compared to silent data corruption from a stale schema reading new-format data.

### Keep `down()` until the migration is finalized + a few releases past

After finalize, only v2 exists. `down()` is what reconstructs v1 if you need to roll back. Removing `down()` from a finalized migration permanently removes the rollback path. Treat it as load-bearing for at least one full release cycle past finalization.

### `appliedBy` on serverless / CI

The default is `${hostname()}:${pid}` — informative on a dev box, useless on Lambda or CI. Override:

```ts
createMigrationsClient({
  client, table,
  appliedBy: `gh-actions:${process.env.GITHUB_RUN_ID}`,
});
```

This shows up in `_migrations.appliedBy` and `LockHeldError.heldBy` for every operation.

### `concurrent` is for the write step only

Apply/finalize/rollback take a `concurrent` option that controls how many DDB write ops run in parallel during the write phase. Your `up()` / `down()` transform itself runs `Promise.all`-style with no cap — if your transform does network I/O (a third-party API call per item), a 1000-item page fans out 1000 in-flight requests. Either keep transforms pure or cap them yourself.

### Observability via `onProgress`

```ts
await migrate.apply({
  migrations,
  onProgress: (event) => {
    if (event.type === 'scan-page') logger.info({ page: event.page, count: event.count }, 'page');
    if (event.type === 'error') logger.error({ error: event.error }, 'migration error');
  },
});
```

Event types: `lock-acquired`, `lock-released`, `heartbeat`, `operation-start`, `operation-complete`, `scan-page`, `transform-batch`, `write-batch`, `error`.

### Recovery from a crashed runner

If a runner dies mid-migration without releasing (kill -9, OOM, infra failure), the lock stays held until `staleThresholdMs` elapses (default 4h). The next runner takes over via stale-takeover. If you can't wait:

```sh
npx electrodb-migrations reconcile-state --force-unlock
```

This clears the lock fields and rebuilds the aggregate state from per-migration history. Then either re-apply (status was `pending`) or rollback (status was `failed`).

---

## Warnings and pitfalls

### `_migrations` and `_migration_state` live in your table

By design — keeps everything single-table-design friendly. They're namespaced under `service: '_electrodb_migrations'` so they don't collide with your entities. They take a small amount of space in your user table.

### Forgetting to release a deployment block blocks all traffic

`autoRelease: false` is the default precisely because forgetting is loud — the guard throws on every call until you release. This is correct behavior, but be aware:

- A failed deploy that never reaches the "release" step leaves your app down.
- `electrodb-migrations release --all` is the operator escape hatch.
- Set `blockMode: 'writes-only'` if your app can tolerate stale reads during a stuck deploy.

### The bake window is your responsibility

Between `apply` and `finalize`, both v1 and v2 rows coexist on disk. The migration runner converts existing v1 records to v2 records, but **new writes after `apply` only go to whichever entity version your code uses**. If your code only uses v2, any v1 records that were missed during apply (extremely rare, but possible if the scan fell behind concurrent writes) will sit in v1 forever.

That's almost always fine — `finalize` deletes them. But if you have heavy concurrent-write traffic during a long migration and need 100% coverage, you'd need to dual-write from your app (write both v1 and v2) until apply completes. The framework does not do this for you.

### `staleThresholdMs` default is 4 hours

Long migrations on slow boxes shouldn't be "stolen" because the heartbeat fell behind by a couple of minutes. The trade-off: a genuinely crashed runner blocks new work for up to 4 hours unless someone calls `reconcile-state --force-unlock`. Tune for your environment.

### Behavior-only changes don't trigger drift

`validate`, `get`, `set`, `condition`, `watch`, and function-valued `default`s aren't part of the fingerprint. Changing them won't make `status` show drift. If you know your behavior change requires data work, use `create --force` to scaffold a migration anyway.

### Schema-only history is final

Once a migration is committed, its `v1.ts` and `v2.ts` are immutable. Don't edit them. If you discover you needed a transform that depends on a custom validator, do that work in `migration.ts` (where you can freely import from your live source).

### `--force-unlock` has no audit trail

It's an unconditional clear of the lock fields. Anyone with write access to the table can call it. There's no record of who did it or why. Wrap it yourself if you need that.

### Transaction cost

Every successful lifecycle transition issues a DDB `TransactWriteItems` (2 items). DDB charges 2x WCU for transactional writes. For migration-scale traffic this is negligible — a handful of transactions per migration.

### ElectroDB version pinning

`electrodb >= 3.0.0` as peer dep. Tested against 3.7.x. The `Service.transaction.write` API and `where`-callback ops are what we lean on most heavily; if you pin a newer version with a breaking change in those areas, the integration test suite is the canary.

---

## Errors

All lifecycle errors extend `ElectroDBMigrationError`. ElectroDB's own errors propagate unchanged so you can split DB-layer from lifecycle errors via `instanceof`.

| Error | Thrown when |
|---|---|
| `LockHeldError` | Another runner holds the lock and it's not stale |
| `LockLostError` | The wait-and-verify or heartbeat saw a different `refId` — someone took over |
| `RequiresRollbackError` | `apply` called on a `failed` or `reverted` migration |
| `RollbackNotPossibleError` | Post-finalize rollback without `down`, or rollback of an already-reverted migration. `reason` is `'no-down-fn'` or `'already-reverted'`. |
| `FingerprintMismatchError` | Stored fingerprint differs from current entity's fingerprint (drift detected at boot in `strict` mode) |
| `MigrationFailedError` | `apply`/`finalize`/`rollback` threw mid-loop. `cause` carries the original error. |
| `MigrationInProgressError` | Guard wrapper rejected a call. `reasons[]` is `('locked' \| 'failed-migration' \| 'deployment-block')[]`. Use `.isReason('locked')` as a convenience predicate. |

---

## Embedding the runtime (Node API)

The CLI is the supported front door. Everything it does sits on top of a Node API you can call directly when the CLI doesn't fit (custom orchestration, in-process migration runners, embedded use cases).

```ts
import { createMigrationsClient } from 'electrodb-migrations';
import migrations from './migrations/index.js';

const migrate = createMigrationsClient({
  client: docClient,
  table: 'app-table',
  appliedBy: 'embedded-runner:1',
});

await migrate.apply({ migrations, autoRelease: true });
await migrate.finalize({ migration: migrations[0] });
```

Methods on the returned client:

| Method | Description |
|---|---|
| `apply(opts)` | Run pending migrations |
| `finalize(opts)` | Delete v1 for one applied migration |
| `rollback(opts)` | Undo, pre- or post-finalize |
| `getStatus({ migrationId })` | Read one `_migrations` row |
| `getLockState()` | Read the lock view |
| `getGuardState()` | Single GetItem on `_migration_state` — what the wrap-client middleware reads |
| `ensureApplied({ migrations, mode })` | Boot-time check |
| `releaseDeploymentBlock({ migrationId })` | Clear one deployment block |
| `releaseAllDeploymentBlocks()` | Clear every active deployment block |
| `reconcileState()` | Rebuild `_migration_state` from per-migration history |
| `forceUnlock()` | Operator escape hatch — clears lock fields only |

`migrations` is the array auto-exported from `migrations/index.ts`. The framework generates and maintains that file; you import it.

`defineMigration` is also exported but you rarely call it directly — the scaffolder writes the call for you inside each `migration.ts`.

---

## Out of scope (for v0.x)

- Resume-from-cursor on partial failure. If `apply` fails mid-loop, you must `rollback` and re-`apply`.
- Per-entity / per-migration-id parallelism. See [FUTURE_IDEAS.md](FUTURE_IDEAS.md).
- A built-in dual-write helper for the bake window.
- An HTTP-layer guard middleware. The data-access guard ships in [src/guard/](src/guard/); the 503 conversion is the snippet above.
- DDB-Streams-based push invalidation of the guard cache (TTL polling is enough for v0.x).
- Subclassing ElectroDB's own error types.
- Full-fidelity historical entities. Frozen entities are schema-only; behavior lives in your live source.

---

## License

Apache-2.0.
