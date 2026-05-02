# DEV_README — Reviewer's Guide

This document is a reading guide for reviewing `electrodb-migrations`. It explains the problem the framework solves, the mental model behind the design, what each module does, and the points worth scrutinising on a code review.

The library was assembled quickly, so use this guide to direct attention to the areas where the design encodes non-obvious decisions, and to the places where the implementation is most likely to harbour bugs.

> File pointers in this guide use clickable references like [src/core/apply-migrations.ts](src/core/apply-migrations.ts). Behaviour citations may have drifted slightly from the source — verify against the current code before forming a judgement.

---

## 1. What the framework does

ElectroDB models DynamoDB items as versioned entities (`model.entity` + `model.version`). When a schema changes (rename, add required field, change shape), you have to migrate the on-disk records — but DynamoDB has no native migration tooling, and ElectroDB has no opinion about it.

`electrodb-migrations` is a **parallel-write migration runner** for ElectroDB:

1. You define `v1` and `v2` Entities and a `up(item) => item` transform.
2. **`apply`** scans `v1`, transforms each item, and writes a `v2` item alongside. Both versions coexist on disk.
3. App traffic moves to reading/writing `v2`. (This is your "bake window" — verify nothing broke.)
4. **`finalize`** deletes the leftover `v1` rows. Now only `v2` exists.
5. **`rollback`** can undo at either stage:
   - Pre-finalize: delete `v2`, leave `v1`.
   - Post-finalize: re-derive `v1` from `v2` via `down()`, then delete `v2`. Requires `down`.

It also provides:
- A **global lock** to prevent two runners (CI, ops box, app boot) from racing.
- A **boot guard** (`ensureApplied`) so an app refuses to start against a stale schema.
- A **runtime guard state** (`getGuardState`) for higher-level routers / middleware to short-circuit traffic during a migration window.
- An **auto migration guard** (`wrapClientWithMigrationGuard`) — a DDB-client wrapper that intercepts every `.send()` and throws `MigrationInProgressError` when a runner is active or any migration is in `failed` state. Defense-in-depth at the data-access layer; works for ElectroDB, raw SDK calls, transactions, queue workers — anything that goes through the AWS SDK.
- A **CLI scaffold** ([src/cli/](src/cli/)) — currently all stubs that throw "Not yet implemented".

---

## 2. Mental model — read this before the code

There are three concurrent timelines you must keep in your head:

```
v1 records on disk     ┃███████████████┃░░░░░░░░░░░░░░░░░░┃
                       ┃                ┃                  ┃
v2 records on disk     ┃               ┃███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                       ┃               ┃   ↑              ┃
_migrations row status ┃ (none)        ┃ pending → applied ┃ → finalized
                       ┃               ┃                  ┃
                       └───────────────┴──────────────────┴── time
                                        ↑                  ↑
                                       apply           finalize
                                       (lock)          (lock)
                                                  (bake window)
```

Three entity rows participate:
- **The user's v1 entity** (`migration.from`) — old data, scanned and transformed.
- **The user's v2 entity** (`migration.to`) — new data, written during apply, becomes canonical after finalize.
- **`_migrations`** — one row per migration ID, stores the lifecycle status. Source of truth for "did this run?".
- **`_migration_lock`** — a single global row (id=`"global"`) held by the active runner.

The library never modifies the user's `v1` schema or `v2` schema entities directly — it only invokes `entity.scan`, `entity.put`, `entity.delete`. ElectroDB's `__edb_e__` / `__edb_v__` identity stamps mean v1 and v2 records can sit at the same primary key and never collide on reads.

### The 5-state machine

Defined in [src/core/state-machine.ts](src/core/state-machine.ts). Pure functions, no I/O — easy to audit.

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

- **`pending`** — row pre-written at the start of `apply` so failures land on a real row.
- **`applied`** — `up()` finished; both v1 and v2 exist. The bake window starts here.
- **`finalized`** — v1 rows have been deleted. Permanent.
- **`failed`** — `apply` threw mid-loop. The user **must** rollback before re-applying (`RequiresRollbackError`). No resume-from-cursor.
- **`reverted`** — terminal. Re-applying a reverted migration is intentionally hard (a future `--force` is planned).

> **Why `reverted` is terminal:** silently allowing reverted → pending would let an operator forget that data has been physically deleted and re-run a migration whose preconditions no longer hold. The CLI is expected to grow `--force` later.

> **Why no `verifyCounts` on finalize:** during the bake window the app legitimately writes new v2 records, so `count(v1) ≠ count(v2)` is expected. Don't add a count invariant.

---

## 3. Module-by-module guide

### Public surface — [src/index.ts](src/index.ts)

The single entry point is `createMigrationsClient`. Everything else (errors, types, `defineMigration`, `fingerprint`) is supporting surface.

There is **deliberately no free-function API**. An older draft exposed `applyMigrations(...)` etc. directly; that was removed in favour of the factory so the lock context, `appliedBy`, and timing config are configured exactly once per process.

### Factory — [src/core/client.ts](src/core/client.ts)

`createMigrationsClient(opts)` builds the two internal entities once and wires every method to share the same `ApplyContext`:

```ts
{
  migrationsEntity, lockEntity,
  appliedBy: opts.appliedBy ?? `${hostname()}:${pid}`,
  staleThresholdMs: opts.staleThresholdMs ?? 4 * 60 * 60 * 1000,  // 4 hours
  heartbeatMs:      opts.heartbeatMs      ?? 10_000,
  acquireWaitMs:    opts.acquireWaitMs    ?? 10_000,
}
```

Returned methods:
- `apply(opts)` — run pending migrations.
- `finalize(opts)` — delete v1 for one applied migration.
- `rollback(opts)` — undo, pre- or post-finalize.
- `getStatus({ migrationId })` — read one `_migrations` row.
- `getLockState()` — read lock row, compute `stale`.
- `getGuardState()` — composite (lock + scan for `failed` rows). Used by the future API guard middleware.
- `ensureApplied({ migrations, mode })` — boot-time check.
- `forceUnlock()` — operator escape hatch; deletes the lock row regardless of `refId`.

Exposes `migrationsEntity` and `lockEntity` for advanced/escape-hatch queries.

**Reviewer points:**
- `getGuardState()` does **two** reads (lock + scan). The comment notes the consumer should cache (~1s) if mounted on every request. Confirm that warning is accurate before recommending it on a hot path.
- `forceUnlock` has no auth/audit trail. That's intentional for v0.1 but worth flagging.

### Migration definition — [src/core/define-migration.ts](src/core/define-migration.ts)

`defineMigration` is an identity function. Its job is to give TypeScript the generic context to type-check `up(EntityItem<TFrom>) => EntityItem<TTo>` and `down(EntityItem<TTo>) => EntityItem<TFrom>`. Runtime cost: zero.

### Apply — [src/core/apply-migrations.ts](src/core/apply-migrations.ts)

Reading order:
1. `applyMigrations` (top) loops migrations, asks `decideApply(existing.status)` what to do.
2. `runOne` is where the work happens.

The flow inside `runOne`:
1. `acquireLock` — global lock for `migrationId`.
2. **Pre-write** the `pending` row with all metadata (versions, fingerprint of `to`). Even if the loop crashes, the `_migrations` row exists for the next runner to see.
3. Start a `setInterval` heartbeat. If it ever throws `LockLostError`, store it in a closure variable and let the main loop pick it up at the next iteration.
4. Paginate `from.scan` → `Promise.all(items.map(up))` → `to.put(transformed).go({ concurrent })` → repeat until no cursor.
5. On success, set status to `applied` with counts, `appliedAt`, `appliedBy`.
6. On any throw: set status to `failed` (best-effort, swallowed if the failure write itself fails), emit `error` progress event, rethrow as `MigrationFailedError` unless it's already an `ElectroDBMigrationError`.
7. `finally` clears the heartbeat interval and releases the lock.

**Reviewer points:**
- **Heartbeat-loss check timing.** The `heartbeatLost` check happens at the top of the scan loop and once after the loop. If `up()` runs for hours on a single page, the loop won't notice a stolen lock until that page finishes. This is acceptable if pages are bounded, but worth confirming.
- **`Promise.all(... up)` has no concurrency cap on the user's transform function.** Only the `to.put(...).go({ concurrent })` write step respects `concurrent`. If `up()` does I/O (e.g., calls a third-party API), a 1000-item page will fan out 1000 in-flight requests. Document this or cap it.
- **`from.scan.go(goOpts)`** uses ElectroDB's cursor-based pagination. The default page size is whatever ElectroDB defaults to (~ DDB's 1MB scan limit). No item-count bound per page is enforced.
- **No transactional guarantee.** A v1 record written between the scan-page and the v2 put will be missed. The "bake window" is what catches this — the app keeps dual-writing v2 until finalize. There is no built-in dual-write helper; the user is on the hook for it.
- The pre-written `pending` row passes only required fields; `appliedAt`/`appliedBy`/`itemCounts` are added later. Look at the entity schema in [src/entities/migrations.ts](src/entities/migrations.ts) — `fingerprint` is `required`, so the v2 entity must have a model the fingerprint function can hash even before any work happens.

### Finalize — [src/core/finalize-migration.ts](src/core/finalize-migration.ts)

Same skeleton as apply (lock + heartbeat + paginated scan). The body just calls `migration.from.delete(res.data).go({ concurrent })`.

**Reviewer points:**
- Scans `from`, not `to`. After finalize, `from` should be empty. If the app dual-wrote v1 during the bake window and then stopped, this loop catches the leftovers.
- No idempotency cursor — if finalize crashes halfway, re-running it will scan again and only see the v1 rows still present. Safe.

### Rollback — [src/core/rollback-migration.ts](src/core/rollback-migration.ts)

The branching here is the most interesting bit. `decideRollback(currentStatus)` returns one of:
- `pre-finalize` — current status is `applied` or `failed`. v1 still exists. We just delete v2.
- `post-finalize` — v1 is gone. We need `migration.down`; if absent we throw `RollbackNotPossibleError({ reason: 'no-down-fn' })`. Otherwise: scan v2 → run `down()` → put back v1 → delete v2.
- `no-op` — no row, or status is `pending` (nothing to undo).
- `already-reverted` — throws `RollbackNotPossibleError({ reason: 'already-reverted' })`.

`runRollbackLoop` (bottom of file) is the inner work loop, factored out because the two branches share most of the structure.

**Reviewer points:**
- Post-finalize rollback **always** requires `down()`. There's no "best effort" path.
- `down()` runs with the same uncapped `Promise.all` concern as `up()`.
- The status flips to `reverted` only after the loop completes. If rollback crashes, the row stays at `applied`/`finalized`/`failed` — correct, because the data is in an inconsistent state and a human should look.

### Lock — [src/core/lock.ts](src/core/lock.ts)

This is the most subtle module — read it carefully.

Algorithm for `acquireLock`:
1. Generate `refId = randomUUID()`.
2. Conditional `put` with where-clause `notExists(refId) OR heartbeatAt < staleCutoff`. So a fresh lock or a lock whose heartbeat is older than `staleThresholdMs` (default 4 hours) lets us in.
3. **Sleep `acquireWaitMs` (default 10s).**
4. Strongly-consistent re-read. If the row's `refId` is not ours, throw `LockLostError`.

The wait-and-verify is **defence in depth**. The conditional put is already correct under DDB's serialization. The 10-second wait + verify catches the unlikely race where two runners both believe they won — mostly a hedge against any subtle inconsistency in the conditional-write path or test environments. The lock test [tests/integration/lock.test.ts:95](tests/integration/lock.test.ts#L95) ("wait-and-verify catches a racing overwrite") demonstrates the scenario.

`heartbeat` does a conditional update with `where eq(refId, ourRefId)`. If the conditional check fails (someone stole the lock via stale takeover), we read the row to find out who, and throw `LockLostError`.

`releaseLock` does a conditional delete with the same where-clause. **Silently no-ops** if the lock has been stolen — there's nothing for us to clean up, and racing with another runner's release is fine.

`isConditionalCheckFailed(err)` checks both `err.name` and `err.cause?.name` because ElectroDB sometimes wraps the AWS SDK error. Worth verifying the wrapping is still consistent on the version of ElectroDB pinned in `package.json`.

**Reviewer points:**
- **Default `acquireWaitMs = 10s`** is a hard cost on every apply. Reasonable for ops migrations; surprising in tests. Note the integration tests pass `acquireWaitMs: 50` to keep them fast.
- **Default `staleThresholdMs = 4 hours`.** The user explicitly bumped this from 60s. The argument: a long migration on a slow box should not be "stolen" just because the heartbeat fell behind by a couple of minutes. Trade-off: a genuinely crashed runner blocks new work for up to 4 hours unless someone calls `forceUnlock()`. This is the right default for the user's environment but should be reviewed for any CI use case.
- **Heartbeat is fire-and-forget inside `setInterval`.** If a heartbeat takes longer than `heartbeatMs` (default 10s), they queue up. Not fatal, but if the underlying DDB call hangs, you can leak timers. The interval is cleared in `finally`, so the leak is bounded by the operation duration.
- The "race" branch in the catch (`(unknown)` sentinel) is rarely exercised — call out if you see test coverage gaps.

### State machine — [src/core/state-machine.ts](src/core/state-machine.ts)

Pure decision functions. **Read this file end-to-end** — it's the policy in one place. Any disagreement with the lifecycle should be debated against this file.

Tested in [tests/unit/state-machine.test.ts](tests/unit/state-machine.test.ts).

### Boot guard — [src/core/ensure-migrations-applied.ts](src/core/ensure-migrations-applied.ts)

For each migration the app expects:
1. The `_migrations` row exists.
2. Its status is acceptable: `verify` mode allows `applied|finalized`, `strict` mode requires `finalized`.
3. The stored `fingerprint` matches the current v2 schema's fingerprint (no drift).

Throws on the first failure — fail fast at boot rather than mid-traffic.

**Reviewer points:**
- Fingerprint mismatch is loud. If you change a v2 model attribute after applying, the next boot fails until you scaffold a new migration. Good safety net; makes the dev loop slightly stricter.

### Fingerprint — [src/core/fingerprint.ts](src/core/fingerprint.ts)

Canonical-JSON + sha256. Sorts object keys recursively, strips `undefined`, preserves array order (semantically meaningful in schemas).

Tested in [tests/unit/fingerprint.test.ts](tests/unit/fingerprint.test.ts).

### Errors — [src/errors.ts](src/errors.ts)

A custom hierarchy rooted at `ElectroDBMigrationError`. The decision was deliberate: **not** subclasses of ElectroDB's own errors.

- `LockHeldError` — couldn't acquire because someone fresher holds it.
- `LockLostError` — held briefly, then stolen during verify or heartbeat.
- `RequiresRollbackError` — apply called on a `failed`/`reverted` row.
- `RollbackNotPossibleError` — `reason: 'no-down-fn' | 'already-reverted'`.
- `FingerprintMismatchError` — schema drift detected at boot.
- `MigrationFailedError` — wraps any underlying cause from `up()` or DDB.
- `MigrationInProgressError` — thrown by the auto migration guard when the wrapped client is called during a migration window. Carries a `reason: 'locked' | 'failed-migration' | 'both' | 'guard-check-failed'` discriminator and the relevant context (`lock`, `failedMigrations`, or `cause`).

**ElectroDB's own errors propagate unchanged** (ElectroError, validation errors, conditional-check etc.) so callers can split DB-layer errors from lifecycle errors via `instanceof`.

**Reviewer points:**
- `MigrationFailedError`'s `cause` chain — worth confirming it survives across the wrap point in apply (`apply-migrations.ts:165`).
- The `is*` (e.g. `isConditionalCheckFailed`) helpers live in `lock.ts`, not in `errors.ts`. Probably belongs in a shared spot if more error classification helpers appear.

### Entities — [src/entities/migrations.ts](src/entities/migrations.ts), [src/entities/migration-lock.ts](src/entities/migration-lock.ts)

Two ElectroDB entities. Both:
- Live in the user's table.
- Use `service: '_electrodb_migrations'` to namespace away from user entities.
- Have a single index `byId` with `pk: ['id']`, `sk: []`.
- Honour the optional `identifiers` config so users with custom `__edb_e__` / `__edb_v__` field names work.

`migration-lock` exports the sentinel `GLOBAL_LOCK_ID = 'global'` — there's exactly one row at runtime.

**Reviewer points:**
- `_migration_lock`'s `heartbeatAt` is ISO-8601, which sorts lexicographically the same as chronologically. That makes the conditional `lt(heartbeatAt, cutoff)` comparison correct without any number-coercion gymnastics. **Don't** change to a millisecond integer without revisiting the conditional expression.
- The library decided on **one global lock** for the whole table, not per-migration or per-entity. Per-migration parallelism is unsafe because stacked migrations need linear lineage (e.g. v1→v2→v3 must run in order).

### Auto migration guard — [src/guard/wrap-client.ts](src/guard/wrap-client.ts), [src/guard/cache.ts](src/guard/cache.ts), [src/guard/command-classification.ts](src/guard/command-classification.ts)

`wrapClientWithMigrationGuard(opts)` returns a `DynamoDBDocumentClient` that intercepts every `.send()` via AWS SDK middleware. When the (cached) guard state says blocked, the call throws `MigrationInProgressError` instead of going to the wire.

```ts
const raw = new DynamoDBClient({ region, endpoint, credentials });
const docClient = DynamoDBDocumentClient.from(raw);

// Migration runner uses the unguarded doc client.
const migrate = createMigrationsClient({ client: docClient, table });

// User entities use the guarded doc client.
const guarded = wrapClientWithMigrationGuard({
  client: raw,                  // accepts raw OR a DynamoDBDocumentClient
  migrationsClient: migrate,
  cacheTtlMs:    1_000,         // optional, default 1000
  blockMode:     'all',         // optional, 'all' | 'writes-only'
  failureMode:   'closed',      // optional, 'closed' | 'open'
});

const User = new Entity(userSchema, { client: guarded, table });
```

**The two-client setup is intentional.** AWS's SDK shares the middleware stack by reference between every `DynamoDBDocumentClient.from(raw)` wrapper of a given raw client (`@aws-sdk/lib-dynamodb`'s `DynamoDBDocumentClient` constructor literally does `this.middlewareStack = client.middlewareStack`). So adding middleware to one wrapper affects every other wrapper of the same raw client. To avoid the migration runner being blocked by its own guard, the wrapper internally constructs a **sibling raw client** (same config, separate middleware stack) and returns a fresh doc-client wrapping it. Two connection pools, but isolation is guaranteed without any AsyncLocalStorage threading.

**Module breakdown:**

- **[cache.ts](src/guard/cache.ts)** — TTL cache around `migrationsClient.getGuardState()`. Concurrent first-fetches share one in-flight promise (no thundering herd on cold start). Errors are also cached for the TTL — under `failureMode='closed'` we fail fast for `cacheTtlMs` without re-querying a degraded DDB. `invalidate()` is exposed for forcing a refresh; not currently used by `wrap-client` but available for future "force-refresh after a guard throw" logic.
- **[command-classification.ts](src/guard/command-classification.ts)** — read-vs-write set used by `blockMode='writes-only'`. PartiQL `Execute*` and any unknown command are conservatively treated as writes.
- **[wrap-client.ts](src/guard/wrap-client.ts)** — the factory. Reads the input client's `.config`, builds an isolated raw via `new DynamoDBClient(config)`, wraps it with `DynamoDBDocumentClient.from`, attaches the guard middleware at `step: 'build'` with `priority: 'high'` so the guard fires *before* the SDK retry middleware (a guard rejection is not a transient network failure and must surface immediately).

The middleware function signature is the standard `(next, context) => async (args) => ...`. `context.commandName` is the AWS SDK command class name (e.g. `'GetItemCommand'`, `'PutCommand'`) which is what `isReadCommand` keys on.

**Reviewer points:**
- **Two connection pools.** The wrapper duplicates the underlying connection. Negligible for migration tooling; could matter for serverless or extremely high-fan-out apps.
- **Cache TTL default = 1000ms.** Up to 1s of "guard is stale" is tolerated. The runner's 10s wait-and-verify window is long enough that any reader racing in with stale `blocked: false` sees the truth before mutations begin. Worth re-confirming if `acquireWaitMs` is ever lowered below the cache TTL.
- **`blockMode: 'all'` default blocks reads too.** A 30-minute apply on a busy table effectively returns 503 to all read traffic for 30 minutes. Operators with multi-version-aware read paths can switch to `'writes-only'`. Document this clearly to consumers.
- **`failureMode: 'closed'` default.** When DDB is unreachable for the guard fetch, every wrapped call throws `MigrationInProgressError({ reason: 'guard-check-failed' })`. Safer than fail-open but means a transient DDB control-plane blip 503s the app. Configurable to `'open'`.
- **Throwing from the middleware ends the SDK chain cleanly.** A synthetic 4xx-shaped error is what we want — confirmed against the SDK retry strategy, which doesn't retry custom errors. If we ever switch to a class that the SDK heuristically classifies as transient, we'd start surprising retries.
- **Cache errors share the TTL with happy-path responses.** Intentional, but it means a one-second outage in `getGuardState` causes a one-second window where every wrapped call throws regardless of actual lock state. Trade-off is "no thundering herd against a degraded DDB."
- **Cache is per-wrapped-client.** If a user calls `wrapClientWithMigrationGuard` twice with the same `migrationsClient`, they get two independent caches (and two isolated raw clients). That's almost certainly not what they want; document or warn.

### CLI — [src/cli/index.ts](src/cli/index.ts) and [src/cli/commands/](src/cli/commands/)

Commander-based. **Every command currently throws `Not yet implemented`** — only the argument schema is in place. Treat the CLI as scaffolding, not functionality.

The plan is to pair Commander (argument parsing) with `@clack/prompts` (interactive UI) when M3 lands.

**Reviewer points:**
- Commands are wired but inert. Don't review behaviour; review *the interface*: are the flags right, are the descriptions right, do the commands cover the lifecycle?
- The set: `init`, `baseline`, `status`, `diff`, `create`, `plan`, `apply`, `finalize`, `rollback`, `accept`. Note `plan` is a dry-run, `accept` treats current drift as a no-op.

---

## 4. Tests — [tests/](tests/)

Two suites:
- **Unit** — fast, in-process, only pure-logic modules: errors, define-migration, fingerprint, state-machine. Run via `pnpm test`.
- **Integration** — hit DynamoDB Local on `localhost:8000`. Bring up via `docker compose up -d` first; run via `pnpm test:integration`.

Each integration test resets a uniquely-named table in `beforeEach` (see [tests/integration/helpers/reset-table.ts](tests/integration/helpers/reset-table.ts)), so they're parallel-safe.

Common test fixtures: `createUserV1` / `createUserV2` / `createUserMigration` in [tests/integration/helpers/fixtures.ts](tests/integration/helpers/fixtures.ts).

Per the project memory, the M2 milestone shipped with **47 unit + 52 integration tests passing** — a useful baseline if you spot regressions.

---

## 5. Tooling and conventions

- **Package manager**: pnpm.
- **Build tool**: tsup, dual ESM+CJS output. Two tsconfigs: `tsconfig.json` for IDE/typecheck (includes tests), `tsconfig.build.json` for tsup (src only). Don't merge them.
- **Linter**: Biome. `noExplicitAny` is **off** because ElectroDB's generic constraints (`Entity<any, any, any, any>`) need it; every `any` should have a `biome-ignore` comment with a reason.
- **File names**: kebab-case.
- **Functions**: arrow, `const name = (...) => ...`. No `function` keyword.
- **Imports**: `import type { ... }` for type-only (`verbatimModuleSyntax` is on). Local imports use `.js` extension on `.ts` source files (NodeNext resolution).

Scripts: `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm check`.

---

## 6. What to scrutinise on review

If you have limited time, prioritise these:

1. **`acquireLock` algorithm** ([src/core/lock.ts:31](src/core/lock.ts#L31)). The conditional-put + 10s wait + verify is the safety story. Make sure you believe the `where` expression is correct and that the verify branch handles all three outcomes (won, lost, race-and-row-gone).
2. **State machine transitions** ([src/core/state-machine.ts](src/core/state-machine.ts)). Is `reverted → terminal` what you want? Is `failed → must rollback` what you want? Do the comments in the calling sites match the policy here?
3. **`apply` failure-write best-effort** ([src/core/apply-migrations.ts:148-159](src/core/apply-migrations.ts#L148-L159)). If the failure-write throws, the original error reaches the caller but the `_migrations` row is stuck on `pending`. Is that acceptable? (The next runner will hit `decideApply` returning `proceed`, since `pending` is treated as proceed-able.)
4. **Uncapped `Promise.all` over user transforms** in apply and rollback. If `up()`/`down()` does network I/O, this fans out per-page. Worth a `concurrent`-capped `pMap` instead.
5. **Heartbeat staleness threshold of 4 hours.** Sensible default for a slow ops migration; a crashed runner blocks new work for 4 hours unless someone calls `forceUnlock`. Confirm this is the right default for *your* environment before merging.
6. **`getGuardState` cost.** Two reads per call (lock + scan for failed). The comment recommends ~1s caching at the app layer. If anyone wires it into a hot path without caching, latency suffers.
7. **Fingerprint sensitivity.** Any noisy schema metadata change (a new optional attribute on v2 *after* apply) trips `FingerprintMismatchError` at boot. Inspect what the fingerprint includes and whether you'd want to exclude any fields.
8. **Error semantics.** `instanceof ElectroDBMigrationError` for lifecycle, `instanceof ElectroError` for DDB layer. Confirm nothing in the lifecycle paths accidentally rethrows a DDB error wrapped as a lifecycle error (or vice versa) — that would break the consumer's catch logic.
9. **CLI is stubs.** All `Not yet implemented`. Don't sign off on the CLI as if it works.
10. **Guard wrapper isolation strategy** ([src/guard/wrap-client.ts](src/guard/wrap-client.ts)). The wrapper builds a sibling raw `DynamoDBClient` from the input's resolved config so the new middleware stack doesn't bleed into the migration runner's stack. Verify the cast through `unknown` is sound — `client.config` is the resolved config object, which the SDK accepts back through the `DynamoDBClient` constructor at runtime, but TypeScript can't see that without help. If the SDK's config-resolution semantics change in a future version, this is the line that breaks.
11. **Guard `blockMode: 'all'` blocks reads.** During an active runner the wrapped client throws on every read — including reads that are technically safe (different entity, different version). For most apps this is the right default; for read-heavy workloads with multi-version-aware code it's worth flipping to `'writes-only'` or wiring the Express layer to fall back to a degraded mode.
12. **Guard cache TTL + acquire-wait interaction.** The 1s default cache TTL relies on the runner's 10s `acquireWaitMs` to ensure no reader can slip through with stale "not blocked" state. If anyone lowers `acquireWaitMs` below `cacheTtlMs`, the wait-and-verify safety story breaks. Add a runtime check or document the invariant.

### Smaller things worth a glance

- The `appliedBy` default is `${hostname()}:${pid}` — useful for one-box dev, useless on serverless / CI runners. Override it via factory config.
- `forceUnlock` has no audit trail.
- `_migrations` and `_migration_lock` live in the user's table. Document this clearly in user-facing docs; some teams will want them in a separate table.
- Tests reset tables on `beforeEach`. Several tests use the same table name across `describe` blocks within one file; that's fine because Vitest serialises tests in a file. Across files, table names differ.

---

## 7. Quick reference — file map

```
src/
  index.ts                       Public exports
  types.ts                       Shared option / event / state types
  errors.ts                      ElectroDBMigrationError hierarchy
  core/
    client.ts                    createMigrationsClient — the only entry
    define-migration.ts          Typed identity helper for migration objects
    fingerprint.ts               Canonical-JSON sha256 of the v2 schema
    state-machine.ts             Pure decideApply / decideFinalize / decideRollback
    apply-migrations.ts          Scan v1, transform via up, write v2
    finalize-migration.ts        Delete v1
    rollback-migration.ts        Pre- and post-finalize undo paths
    ensure-migrations-applied.ts Boot-time status + fingerprint guard
    get-migration-status.ts      One row read from _migrations
    lock.ts                      acquire / heartbeat / release / read
    applied-by.ts                Default `${hostname()}:${pid}`
  entities/
    migrations.ts                _migrations entity (status row per migration)
    migration-lock.ts            _migration_lock entity (single global row)
  guard/
    wrap-client.ts               wrapClientWithMigrationGuard — DDB-call interception
    cache.ts                     TTL cache + inflight dedupe over getGuardState
    command-classification.ts    Read-vs-write command names for blockMode='writes-only'
  cli/                           Commander scaffolding — all stubs
  utils/sleep.ts                 Test-friendly setTimeout wrapper
tests/
  unit/                          Pure-logic tests
  integration/                   Hit DDB Local; helpers/ has ddb / reset-table / fixtures
plan/
  PLAN.md, RESEARCH.md, etc.     Original design docs (not authoritative — code is)
```

---

## 8. Out of scope (for v0.1)

- Resume-from-cursor on partial failure (rejected as too complex).
- Per-entity / per-migration-id parallelism.
- A built-in dual-write helper for the bake window.
- Functioning CLI commands.
- An HTTP-layer guard middleware (Express/Fastify). The data-access guard ships in [src/guard/](src/guard/); converting `MigrationInProgressError` into a 503 is a one-liner the consumer writes.
- DDB-Streams-based push invalidation of the guard cache (TTL polling is enough for v0.1).
- Subclassing ElectroDB's own error types.

If you want any of these, raise it before merging — the design intentionally avoids them.
