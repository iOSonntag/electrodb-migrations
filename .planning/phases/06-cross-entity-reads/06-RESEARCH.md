# Phase 6: Cross-Entity Reads — Research

**Researched:** 2026-05-09
**Domain:** ElectroDB Entity API, read-only proxy design, fingerprint validation, runner ctx injection
**Confidence:** HIGH

---

## Summary

Phase 6 wires a `ctx` argument into the runner's `up()` and `down()` calls. The `ctx` object exposes a single method `ctx.entity(Other)` that returns a read-only facade over the caller-supplied `Other` entity, bound to the runner's **unguarded** DynamoDB client. Three safety invariants are enforced before any DDB call: (1) the entity being requested is not the same entity currently being migrated (`EDBSelfReadInMigrationError`), (2) the on-disk snapshot fingerprint of the requested entity matches the fingerprint of the imported source (`EDBStaleEntityReadError`), and (3) write methods on the proxy throw a reads-only error before issuing any network call.

The infrastructure for this phase is almost entirely already in place. The error classes (`EDBStaleEntityReadError`, `EDBSelfReadInMigrationError`) were scaffolded in Phase 1. The fingerprint projection module (`fingerprintEntityModel`) was built in Phase 1. The `reads` field was added to `Migration` (types.ts) and to the `_migrations` DDB entity (migrations.ts) in Phase 3. The apply-flow runner already persists `reads` at apply time (apply-flow.ts line 132) and threads `ctx` through to `up()` (apply-flow.ts line 143). The `docClient` (unguarded, separate middleware stack) is already available inside `applyFlow` / `applyBatch`.

What Phase 6 must build: the `buildCtx` factory function, the read-only proxy/facade over an Entity instance, the fingerprint pre-flight logic, the CTX-08 rollback check, and the integration tests for all four declared/undeclared × in-bounds/out-of-bounds combinations.

**Primary recommendation:** Use `Entity.setClient()` to re-bind a cloned schema to the unguarded client, and wrap the result in a plain hand-built facade that exposes only `get`, `query`, `scan`, `batchGet`, `find`, `match`, `parse`. Do not use JavaScript `Proxy` — it creates unresolvable TypeScript inference problems with ElectroDB's 5-parameter generic. Do not use a `Service` wrapper — it adds a cross-entity transaction layer that is not needed for read-only access and obscures type inference further.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `ctx` interface definition | API / Library | — | Consumed by user-authored `up()`/`down()` functions; must be a stable, typed contract |
| `buildCtx` factory | Runner / Library | — | Runner owns lock lifecycle and unguarded client reference; ctx is built just before `up()` is called |
| Read-only entity facade | Library utility | — | Pure function of the entity + client; no lock or I/O awareness |
| Fingerprint pre-flight | Runner / Library | Snapshot reader | Reads on-disk `EntitySnapshotFile`; runner calls it at ctx-build time |
| Self-read detection | Runner / Library | — | Runner knows `migration.entityName`; comparison is pure |
| CTX-08 rollback check | Rollback preconditions | `_migrations` audit log | Reads the persisted `reads` set to find cross-entity dependencies |
| `reads` persistence | Apply-flow | `_migrations` entity | Already done; Phase 6 confirms it is correct, no change needed |
| Error classes | Phase 1 (existing) | — | `EDBStaleEntityReadError`, `EDBSelfReadInMigrationError` already exist |

---

## Integration Seams (What Already Exists)

These seams are **verified against the actual source** — not assumed.

### Seam 1 — `up()` already receives `ctx` [VERIFIED: src/runner/apply-flow.ts:143]
```ts
v2 = await args.migration.up(v1, args.ctx);
```
The `ctx?: unknown` field is already threaded through `ApplyFlowArgs`, `applyFlowScanWrite`, and `applyBatch`. Phase 6 only needs to replace `ctx?: unknown` with `ctx?: MigrationCtx` and pass a concrete `buildCtx()` result at the call site.

### Seam 2 — `reads` already in `Migration` type [VERIFIED: src/migrations/types.ts:88]
```ts
reads?: ReadonlyArray<AnyElectroEntity>;
```
Phase 6 does not change the `defineMigration` API or the `Migration` interface.

### Seam 3 — `reads` already persisted on `_migrations` at apply time [VERIFIED: src/runner/apply-flow.ts:130-133]
```ts
...(args.migration.reads !== undefined && args.migration.reads.length > 0
  ? { reads: new Set(args.migration.reads.map(
      (e) => (e as unknown as { model: { entity: string } }).model.entity))
    }
  : {}),
```
Entity names are extracted from `entity.model.entity` (verified: `.research/electrodb/src/entity.js:139`). This already serializes `reads` as a `Set<string>` on the DDB row.

### Seam 4 — `_migrations.reads` is DDB `set` type [VERIFIED: src/internal-entities/migrations.ts:94]
```ts
reads: { type: 'set', items: 'string' },
```
Reading back from the audit log returns `Set<string>`. The CTX-08 precondition check needs only to scan `_migrations` rows and read the `reads` field — no schema change required.

### Seam 5 — unguarded `docClient` is available inside `applyFlow` [VERIFIED: src/runner/apply-flow.ts:14]
```ts
client: DynamoDBDocumentClient,
```
This is the cloned-stack bundle client that bypasses the guard middleware (T-04-11-03 isolation). Phase 6 passes this client to `buildCtx`.

### Seam 6 — fingerprint projection module exists [VERIFIED: src/safety/fingerprint-projection.ts:186]
```ts
export function fingerprintEntityModel(entityModel: unknown): {
  projection: EntityProjection;
  fingerprint: string;
}
```
Callable on any `entity.model` object. The `model` property exists at runtime on every ElectroDB `Entity` instance (verified: `.research/electrodb/src/entity.js:139`).

### Seam 7 — snapshot reader exists [VERIFIED: src/snapshot/read.ts:49]
```ts
export function readEntitySnapshot(path: string): EntitySnapshotFile
```
Returns `{ fingerprint, projection, ... }`. The `fingerprint` field is the SHA-256 hex string written by `fingerprintEntityModel`. Phase 6 uses this to compare on-disk state against the imported entity.

### Seam 8 — snapshot paths module exists [VERIFIED: src/snapshot/paths.ts:43]
```ts
export function entitySnapshotPath(rootDir: string, entityName: string): string
```
Converts an entity name to the canonical `.electrodb-migrations/snapshots/<Name>.snapshot.json` path. Phase 6 uses this to locate the on-disk snapshot for a requested `Other` entity.

### Seam 9 — error classes exist [VERIFIED: src/errors/classes.ts:53-64]
Both `EDBStaleEntityReadError` and `EDBSelfReadInMigrationError` are defined, with codes `EDB_STALE_ENTITY_READ` and `EDB_SELF_READ_IN_MIGRATION` registered in `codes.ts`.

### Seam 10 — rollback preconditions exist [VERIFIED: src/rollback/preconditions.ts:90-173]
`checkPreconditions` already scans `_migrations` rows. Phase 6 adds the CTX-08 cross-entity reads check as an additional refusal case inside this function.

---

## Open Question Resolutions

### OQ1 — Proxy implementation strategy: HAND-BUILT FACADE [HIGH confidence]

**Recommendation:** Build a plain `ReadOnlyEntityFacade<E>` interface and a `buildReadOnlyFacade(entity, unguardedClient, tableName)` function that:
1. Calls `entity.setClient(unguardedClient)` — mutates the entity in place. Wait: `setClient` mutates the original entity object, which is the user's imported live entity. This is unsafe.
2. **Instead:** Create a shallow clone by calling `new Entity(entity.schema, { client: unguardedClient, table: tableName })` — constructs a new instance bound to the unguarded client, using the same schema object. This does not mutate the user's entity.
3. Wrap the new instance in a facade that exposes only the 7 read methods.

**Why not Proxy:**
- ElectroDB's `Entity` uses complex getter chains (`this.query`, `this.scan`, etc.) that reference `this` internally. A `Proxy` intercept on method calls where the `this` context is the proxy rather than the entity instance can break ElectroDB's internal chaining.
- TypeScript `Proxy<Entity<A,F,C,S,P>>` loses all 5 generic type parameters at the call site because `new Proxy(entity, handler)` returns `Entity<A,F,C,S,P>` — technically preserving the type, but the handler's intercept logic requires `as any` casts throughout, defeating type safety.
- The fail-closed requirement (CTX-03 writes throw) is harder to maintain as ElectroDB adds new write methods in future versions — a Proxy allowlist silently allows new methods; a facade silently omits them (the correct behavior for a read-only surface).

**Why not wrapping a Service:**
- `new Service({ Other }, { client, table })` adds collection-query and transaction methods that are inappropriate for a read-only cross-entity accessor.
- It requires knowing all entities at service-construction time; `ctx.entity(Other)` is dynamic at call time.

**Complete read-method list (verified from ElectroDB d.ts `Entity` class, line 5459):**
| Method | Category | Include in facade? |
|--------|----------|--------------------|
| `get` | Read | Yes |
| `query` | Read | Yes |
| `scan` | Read | Yes |
| `batchGet` | Read | Yes |
| `find` | Read | Yes |
| `match` | Read | Yes |
| `parse` | Read (no DDB) | Yes |
| `put` | Write | No — throw |
| `create` | Write | No — throw |
| `upsert` | Write | No — throw |
| `update` | Write | No — throw |
| `patch` | Write | No — throw |
| `delete` | Write | No — throw |
| `remove` | Write | No — throw |

**Write methods that must throw (CTX-03):** `put`, `create`, `upsert`, `update`, `patch`, `delete`, `remove`. All of these are named explicitly on the `Entity` class in the type definitions (verified line 5470-5701). The facade exposes getters for them that return an object whose `.go()` throws immediately, or throws at property access time with `get trap` behavior.

**Simplest implementation of the write trap:** Return an object with a `go` method that throws. This way the fluent chain `ctx.entity(Team).put({...}).go()` throws at `.go()` time, which is after the chain is built but before DDB contact — satisfying CTX-03. Throwing at property access (`entity.put`) would throw earlier, which is also acceptable. The property-access approach is simpler and clearer; the `.go()` approach is safer against hypothetical patterns like `const putBuilder = entity.put(...)` followed by conditional `.go()`.

**Recommendation: throw at the method call itself** (not at `.go()`). This is the earliest possible interception point without breaking ElectroDB's chain-build pattern and still satisfies "before hitting DDB".

[VERIFIED: ElectroDB d.ts line 5470-5701, entity.js line 1381-1384]

---

### OQ2 — Fingerprint storage on `_migrations.reads`: NAMES-ONLY, COMPARE ON-THE-FLY [HIGH confidence]

**Recommendation:** Keep `_migrations.reads` as `Set<string>` (entity names only, as already implemented). At `ctx.entity(Y)` call time, the runner reads the on-disk snapshot for `Y` and computes the fingerprint of the imported `Y` entity. If they differ, throw `EDBStaleEntityReadError`.

**Rationale:** Storing fingerprints in `_migrations.reads` would require changing the DDB entity schema to `reads: { type: 'list', items: { type: 'map', properties: { name: { type: 'string' }, fingerprint: { type: 'string' } } } }` — a schema bump. The current `set` type only stores strings. The benefits are minimal: CTX-05 only validates at `ctx.entity(Y)` call time, and the on-disk snapshot is always available (it was written at `baseline`/`create` time). On-the-fly comparison is cheaper than a schema migration.

**What Phase 7 (CTX-07, VAL-05) needs:** The `validate` gate only needs entity names to check ordering, not fingerprints. Names are sufficient.

**What CTX-08 needs:** The rollback precondition needs to know which entity names migration M declares as reads targets. Names are sufficient.

[ASSUMED — no official spec for this decision; based on analysis of tradeoffs and existing schema]

---

### OQ3 — Self-read detection: ENTITY NAME COMPARISON [HIGH confidence]

**Recommendation:** Compare the entity name of the requested `Other` entity against `migration.entityName`. Self-read detection at `ctx.entity(Other)` call time:
```ts
const otherName = (other as unknown as { model: { entity: string } }).model.entity;
if (otherName === migration.entityName) throw new EDBSelfReadInMigrationError(...)
```
This uses the same `entity.model.entity` access pattern already used in apply-flow.ts line 132.

**`reads: [User]` declared on a User migration:** This is a user error. At `apply` time, when the runner persists `reads`, it should ALSO check whether any declared `reads` target is the migration's own entity, and either (a) reject at apply-time with an early `EDBSelfReadInMigrationError`, or (b) let the runtime check at `ctx.entity(User)` call time handle it. Recommendation: do both — fail at `buildCtx` construction time if `migration.reads` contains `migration.entityName`, which surfaces the bug at the start of the run rather than mid-record-scan.

**Migration ID is not sufficient** — the migration ID is `<timestamp>-<entityName>-<slug>`, so while the entity name is embedded in the ID, using the ID string would be fragile. Use `migration.entityName` directly.

[VERIFIED: entity name access via `entity.model.entity` in apply-flow.ts:132]

---

### OQ4 — Sequencing of stale-entity check: EAGER PRE-FLIGHT AT `buildCtx` TIME [HIGH confidence]

**Recommendation:** Validate fingerprints **eagerly at `buildCtx` construction time** (i.e., when the runner builds `ctx` before calling `up()`), not lazily at the first `ctx.entity(Y)` call.

**Rationale:**
- Eager pre-flight catches stale-entity errors BEFORE any v2 writes hit DDB. If 50,000 records have already been transformed to v2 when the runner encounters a `ctx.entity(Y)` call on record 50,001 that fails with `EDBStaleEntityReadError`, the migration is in a half-migrated state. Under `apply`'s fail-fast semantics, this marks the migration `failed` and forces the operator to run `rollback` — a costly outcome that eager pre-flight prevents entirely.
- This is consistent with the project's core value: "a migration cannot silently corrupt data". An invalid cross-entity read at the 50,001st record is data corruption risk (the first 50,000 records may have been migrated under an incorrect shape assumption).
- Eager pre-flight validates only the declared `reads` targets (from `migration.reads`). Undeclared targets are validated lazily at `ctx.entity(Y)` call time (because the runner does not know which undeclared entities will be accessed before calling `up()`).

**Cache recommendation (OQ8 answer):** After the eager pre-flight, the runner can cache the validation result for the duration of the apply run. Each `ctx.entity(Y)` call after the first returns the cached validated entity without re-reading the snapshot file. The cache is per-run (in-memory, on the `ctx` object), not persisted — there is no TTL concern.

**Undeclared entity fallback (lazy validation):** If `up()` calls `ctx.entity(Z)` where `Z` was not in `migration.reads`, the proxy validates `Z`'s fingerprint at first call and caches the result for subsequent calls within the same run.

[ASSUMED — analysis-based; no official precedent in the codebase for pre-flight vs lazy]

---

### OQ5 — `defineMigration` reads field shape: KEEP `Entity[]` AS-IS [HIGH confidence]

**Recommendation:** Keep `reads?: ReadonlyArray<AnyElectroEntity>` as-is. The type is already correct in `types.ts` and the runner already serializes to names at apply time (apply-flow.ts line 132). No change needed to `defineMigration` API or the `Migration` interface.

**Runtime story:** `Entity[]` at the API surface provides type safety for the user authoring `defineMigration`. The runner serializes to `Set<string>` at apply time for DDB persistence. The runner also has the `Entity[]` reference directly from `migration.reads` at runtime, so it can call `fingerprintEntityModel(entity.model)` without re-importing anything.

[VERIFIED: migration types.ts line 88, apply-flow.ts line 132]

---

### OQ6 — Phase 6 vs Phase 7 boundary: CONFIRMED [HIGH confidence]

**Phase 6 scope (CTX-01..06, CTX-08):**
- `ctx.entity(Other)` proxy injection into `up()` and `down()`
- Read-only enforcement (CTX-03)
- Self-read detection (CTX-04)
- Fingerprint validation (CTX-05) — eagerly at buildCtx, lazily for undeclared targets
- `reads` declaration in `defineMigration` + persistence (CTX-06) — already done, needs test coverage
- CTX-08: rollback refused if any migration on a `reads` target has been applied since M

**Phase 7 scope (CTX-07, VAL-05):**
- `validate` gate that refuses ordering violations (a later-sequenced pending migration on a `reads` target)

**Data shape hand-off to Phase 7:** `_migrations.reads: Set<string>` is already in place. Phase 7's `validate` reads entity names from the `reads` field, computes the migration sequence for each named entity, and refuses if any `reads` target has a pending migration sequenced after M. No Phase 6 schema change is needed for Phase 7.

[VERIFIED: ROADMAP.md phase descriptions, REQUIREMENTS.md CTX-07 and VAL-05]

---

### OQ7 — CTX-08 rollback boundary: PHASE 6 ADDS TO `checkPreconditions` [HIGH confidence]

**Recommendation:** CTX-08 belongs in Phase 6, added to `checkPreconditions` in `src/rollback/preconditions.ts`.

**Rationale:** Phase 5 shipped `checkPreconditions` as a pure truth-table gate. CTX-08 is another refusal condition in that table. The preconditions module already scans `_migrations` rows (step 1, line 92) — the CTX-08 check just needs to inspect `targetRow.reads` and compare against other rows' applied-since-M status.

**Implementation position:** Add as Step 10 after the existing strategy/capability checks (Step 9, line 150). New refusal case:
```ts
// Step 10: CTX-08 — refuse if any migration on a reads target has been applied since M.
if (targetRow.reads && targetRow.reads.size > 0) {
  const blockingMig = findBlockingReadsDependency(allRows, targetRow);
  if (blockingMig) {
    const err = new EDBRollbackNotPossibleError(
      `Cannot rollback ${args.migration.id}: migration ${blockingMig.id} on reads-target entity ${blockingMig.entityName} has been applied after ${args.migration.id}. Roll back ${blockingMig.id} first.`,
      { reason: 'READS_DEPENDENCY_APPLIED', blockingMigration: blockingMig.id, ... }
    );
    return { kind: 'refuse', error: err };
  }
}
```

**New reason code:** Add `READS_DEPENDENCY_APPLIED` to `ROLLBACK_REASON_CODES` in `src/errors/codes.ts`.

[VERIFIED: preconditions.ts structure; ASSUMED for the exact reason code name]

---

### OQ8 — Cache invalidation (answered in OQ4)

Validation is cached per-run on the `ctx` object. Once `ctx.entity(Y)` validates Y at runner-boot time (eager) or at first call (lazy), the result is memoized in a `Map<string, BoundReadOnlyEntity>` on the ctx instance. No re-validation per heartbeat boundary or per record.

**Why this is safe:** The snapshot fingerprint represents the on-disk entity shape at apply-run-start time. If another developer commits a new migration for `Y` during the apply run (extremely unlikely during a single run, which typically completes in seconds to minutes), the runner is already mid-flight with lock held. The guard prevents app writes on the guarded client, but it does not prevent developers from editing source files on disk. However: the runner loaded its migration module at the start of the run — the `migration.reads[i]` entity reference is the frozen import from that module load, and its fingerprint is fixed. The on-disk snapshot was written at `create`/`baseline` time and is not atomically updated mid-run. Cache invalidation per heartbeat boundary would be false security theater.

[ASSUMED]

---

### OQ9 — Test harness story (Phase 8 hand-off)

**Phase 6 deliverable for Phase 8:** Define the `MigrationCtx` interface in a dedicated file (e.g., `src/ctx/types.ts`). Export it from `src/index.ts`. Phase 8's `testMigration` will accept an optional `ctx?: MigrationCtx` injection point so unit tests can pass a fake `ctx`.

**Minimal interface needed by Phase 8:**
```ts
export interface MigrationCtx {
  entity<E extends AnyElectroEntity>(other: E): ReadOnlyEntityFacade<E>;
}
```

**Test harness fake ctx pattern (for Phase 8):**
```ts
// In electrodb-migrations/testing:
export function createMockCtx(overrides?: {
  entity?: (e: AnyElectroEntity) => unknown;
}): MigrationCtx { ... }
```
Phase 6 defines `MigrationCtx` and `ReadOnlyEntityFacade<E>` as public exports. Phase 8 implements `createMockCtx`.

[ASSUMED — Phase 8 scope speculation based on README §8]

---

## Standard Stack

### Core (all already in use)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `electrodb` | peer `>=3.0.0`, dev `^3.7.5` | Entity API — `get`, `query`, `scan`, `batchGet`, `setClient`, `Entity` constructor | Core peer dep; Entity.setClient and new Entity(schema, {client}) are the binding primitives |
| `@aws-sdk/lib-dynamodb` | dev `^3.1041.0` | `DynamoDBDocumentClient` — unguarded client to bind new entity | Already in dev deps |
| `node:crypto` | built-in | SHA-256 via `fingerprintEntityModel` | Already used in fingerprint-projection.ts |

### No New Dependencies

Phase 6 adds zero new npm dependencies. All required primitives are already in the project:
- `fingerprintEntityModel` — `src/safety/fingerprint-projection.ts`
- `readEntitySnapshot` — `src/snapshot/read.ts`
- `entitySnapshotPath` — `src/snapshot/paths.ts`
- Error classes — `src/errors/classes.ts`
- `AnyElectroEntity` — `src/migrations/types.ts`
- Unguarded `docClient` — available inside `ApplyFlowArgs`

---

## Architecture Patterns

### System Architecture Diagram

```
Runner (applyFlow / applyBatch)
  │
  ├── [PRE-RUN BOOT] buildCtx(migration, docClient, tableName, cwd)
  │     │
  │     ├── 1. For each entity in migration.reads:
  │     │       a. entitySnapshotPath(cwd, entityName) → read on-disk fingerprint
  │     │       b. fingerprintEntityModel(entity.model) → compute imported fingerprint
  │     │       c. compare: mismatch → throw EDBStaleEntityReadError (BEFORE any DDB write)
  │     │       d. cache validated entity facade in Map<name, ReadOnlyEntityFacade>
  │     │
  │     └── return MigrationCtx { entity(Other) }
  │
  ├── [PER-RECORD] up(v1Record, ctx)
  │     │
  │     └── ctx.entity(Team)
  │           │
  │           ├── 1. otherName = Other.model.entity
  │           ├── 2. if otherName === migration.entityName → throw EDBSelfReadInMigrationError
  │           ├── 3. if cache.has(otherName) → return cached facade (no re-validation)
  │           ├── 4. [lazy] validate fingerprint for undeclared entity
  │           └── 5. return ReadOnlyEntityFacade { get, query, scan, batchGet, find, match, parse,
  │                    put/create/upsert/update/patch/delete/remove → throws reads-only error }
  │
  └── [ROLLBACK PRECONDITIONS] checkPreconditions (CTX-08 addition)
        │
        ├── Scan all _migrations rows (already done)
        ├── Read targetRow.reads (Set<string> of entity names)
        ├── For each reads-target entity name:
        │     find all _migrations rows for that entity, sorted by fromVersion
        │     if any row has status=applied|finalized AND applied AFTER targetRow → refuse
        └── throw EDBRollbackNotPossibleError(reason: 'READS_DEPENDENCY_APPLIED')
```

### Recommended Project Structure (new files only)

```
src/
├── ctx/
│   ├── index.ts           # barrel — exports MigrationCtx, ReadOnlyEntityFacade, buildCtx
│   ├── types.ts           # MigrationCtx interface, ReadOnlyEntityFacade<E> type
│   ├── build-ctx.ts       # buildCtx factory (pre-flight validation + cache)
│   └── read-only-facade.ts # createReadOnlyFacade(entity, unguardedClient, tableName)
```

Plus modifications to:
- `src/runner/apply-flow.ts` — wire `buildCtx` into `applyFlowScanWrite`; pass `ctx` to `down()` in rollback strategies that call it
- `src/rollback/preconditions.ts` — add CTX-08 step
- `src/errors/codes.ts` — add `READS_DEPENDENCY_APPLIED` reason code
- `src/index.ts` — export `MigrationCtx` and `ReadOnlyEntityFacade` (public for Phase 8 testing)
- `tests/_helpers/sample-migrations/` — new `User-reads-Team/` fixture

### Pattern 1: `buildCtx` factory

```typescript
// src/ctx/build-ctx.ts
// Source: architecture described above; no upstream precedent

import { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
import { readEntitySnapshot } from '../snapshot/read.js';
import { entitySnapshotPath } from '../snapshot/paths.js';
import { EDBStaleEntityReadError, EDBSelfReadInMigrationError } from '../errors/index.js';
import { createReadOnlyFacade } from './read-only-facade.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MigrationCtx } from './types.js';

export async function buildCtx(
  migration: Migration<AnyElectroEntity, AnyElectroEntity>,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  cwd: string,
): Promise<MigrationCtx> {
  // Eager pre-flight: validate all declared reads targets before any DDB write.
  const cache = new Map<string, ReturnType<typeof createReadOnlyFacade>>();

  for (const entity of migration.reads ?? []) {
    const entityName = (entity as any).model.entity as string;
    // Self-read declared in reads array — catch early.
    if (entityName === migration.entityName) {
      throw new EDBSelfReadInMigrationError(
        `Migration '${migration.id}' declares reads: [${entityName}] — a migration cannot read its own entity.`,
        { migrationId: migration.id, entityName },
      );
    }
    // Fingerprint validation.
    const snapshotPath = entitySnapshotPath(cwd, entityName);
    const snapshot = readEntitySnapshot(snapshotPath);
    const { fingerprint: importedFingerprint } = fingerprintEntityModel((entity as any).model);
    if (snapshot.fingerprint !== importedFingerprint) {
      throw new EDBStaleEntityReadError(
        `ctx.entity('${entityName}'): on-disk snapshot fingerprint does not match imported entity. ` +
        `A later migration on '${entityName}' has been applied. Sequence that migration before '${migration.id}'.`,
        { entityName, migrationId: migration.id, onDisk: snapshot.fingerprint, imported: importedFingerprint },
      );
    }
    cache.set(entityName, createReadOnlyFacade(entity, docClient, tableName));
  }

  return {
    entity<E extends AnyElectroEntity>(other: E): ReturnType<typeof createReadOnlyFacade> {
      const otherName = (other as any).model.entity as string;
      // Self-read guard (also catches undeclared self-reads).
      if (otherName === migration.entityName) {
        throw new EDBSelfReadInMigrationError(
          `ctx.entity('${otherName}') called from inside '${otherName}' migration — self-reads are not permitted.`,
          { migrationId: migration.id, entityName: otherName },
        );
      }
      // Return cached facade if already validated.
      const cached = cache.get(otherName);
      if (cached) return cached;
      // Lazy validation for undeclared targets.
      const snapshotPath = entitySnapshotPath(cwd, otherName);
      const snapshot = readEntitySnapshot(snapshotPath);
      const { fingerprint: importedFingerprint } = fingerprintEntityModel((other as any).model);
      if (snapshot.fingerprint !== importedFingerprint) {
        throw new EDBStaleEntityReadError(
          `ctx.entity('${otherName}'): on-disk snapshot fingerprint mismatch.`,
          { entityName: otherName, migrationId: migration.id },
        );
      }
      const facade = createReadOnlyFacade(other, docClient, tableName);
      cache.set(otherName, facade);
      return facade;
    },
  } as MigrationCtx;
}
```

### Pattern 2: `createReadOnlyFacade`

```typescript
// src/ctx/read-only-facade.ts
// Source: analysis of ElectroDB Entity class (.research/electrodb/index.d.ts:5459-5770)

import { Entity } from 'electrodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AnyElectroEntity } from '../migrations/types.js';

const READS_ONLY_ERROR =
  'ctx.entity() is read-only. Writes through ctx are not permitted. ' +
  'Use the migration runner\'s v2 write path (return the transformed record from up()).';

function makeWriteThrow(method: string) {
  return () => {
    throw new Error(`[electrodb-migrations] ctx.entity().${method}() — ${READS_ONLY_ERROR}`);
  };
}

export function createReadOnlyFacade(
  entity: AnyElectroEntity,
  client: DynamoDBDocumentClient,
  tableName: string,
) {
  // Clone the entity bound to the unguarded client.
  // new Entity(schema, config) creates a fresh instance with an independent client reference.
  // This does NOT mutate the user's imported entity.
  const boundEntity = new Entity(
    (entity as any).schema,          // same schema object
    { client, table: tableName },     // new client + table binding
  );

  return {
    get: boundEntity.get.bind(boundEntity),
    query: boundEntity.query,         // ElectroDB query is a namespace object, not a function
    scan: boundEntity.scan,           // same — accessor property
    batchGet: (...args: any[]) => (boundEntity as any).batchGet(...args),
    find: boundEntity.find.bind(boundEntity),
    match: boundEntity.match.bind(boundEntity),
    parse: boundEntity.parse.bind(boundEntity),
    // Write traps (CTX-03):
    put: makeWriteThrow('put'),
    create: makeWriteThrow('create'),
    upsert: makeWriteThrow('upsert'),
    update: makeWriteThrow('update'),
    patch: makeWriteThrow('patch'),
    delete: makeWriteThrow('delete'),
    remove: makeWriteThrow('remove'),
  };
}

export type ReadOnlyEntityFacade = ReturnType<typeof createReadOnlyFacade>;
```

**Note on `query` and `scan`:** ElectroDB's `query` and `scan` are not plain methods — they are namespace objects on the entity instance. Binding them via `.bind()` would produce a bound version of the outer accessor. Instead, reference them directly from the bound entity (`boundEntity.query`, `boundEntity.scan`) which retains the correct `this` context through ElectroDB's chain mechanics. This must be validated by the integration test (CTX success criterion #1).

### Pattern 3: `checkPreconditions` CTX-08 addition

```typescript
// src/rollback/preconditions.ts — Step 10 addition

// Step 10: CTX-08 — refuse if any migration on a reads target has been applied since M.
// "applied since M" means: same entity as reads-target AND status=applied|finalized
// AND the target row's toVersion > targetRow's reads-target migration's fromVersion
// (i.e., a migration on the reads-target entity that moved the entity to a shape
// newer than what M was authored against).
//
// Practical implementation: for each entity name in targetRow.reads, find all
// _migrations rows for that entity. Sort by fromVersion ascending. If any row
// has status=applied|finalized AND its appliedAt > targetRow.appliedAt → refuse.
//
// appliedAt is an ISO string; string comparison is valid for ISO-8601 timestamps.
if (targetRow.reads && (targetRow.reads as Set<string>).size > 0) {
  const blockingMig = findBlockingReadsDependency(allRows, targetRow);
  if (blockingMig) {
    return { kind: 'refuse', error: buildReadsDependencyError(args.migration.id, blockingMig) };
  }
}
```

### Anti-Patterns to Avoid

- **Creating facade with `entity.setClient(client)` directly:** `setClient` mutates the original entity in place. The user's imported entity is shared across runs — mutating it would rebind ALL subsequent uses of that entity to the unguarded client, including uses outside `ctx`. Always create a new Entity instance with `new Entity(schema, {client, table})`.
- **Binding `query` or `scan` with `.bind()`:** `query` is a namespace object, not a function. `entity.query.bind(entity)` is `Function.prototype.bind` called on an object, which will silently fail or produce a bound function that throws when called. Reference the namespace objects directly from the bound entity.
- **Re-validating fingerprint on every record:** Fingerprint validation reads a file from disk. Doing it once at run-start and caching is the correct pattern. Per-record validation would dominate migration runtime on large datasets.
- **Allowing `ctx.entity(Y)` in rollback strategies (`projected`, `fill-only`, `custom`):** The `down()` function also receives `ctx` (per CTX-01). The rollback strategies call `migration.down(v2, ctx)`. The same `buildCtx` factory should be called in the rollback orchestrator's pre-flight, using the same unguarded client pattern. Do NOT skip `ctx` injection in the rollback path.
- **Throwing a generic `Error` for write attempts:** The write-trap error must be clearly identifiable. Use a distinct message prefix `[electrodb-migrations]`. Do not use an `EDB*` error class for this — the write-trap is a programming error, not a runtime DDB error. Plain `Error` with a clear message is correct.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Fingerprint computation | Custom SHA-256 of entity schema | `fingerprintEntityModel()` from `src/safety/fingerprint-projection.ts` (Phase 1) |
| Snapshot file reading | Custom JSON parser for `.snapshot.json` | `readEntitySnapshot()` from `src/snapshot/read.ts` (Phase 1) |
| Snapshot file path | Manual string concatenation | `entitySnapshotPath()` from `src/snapshot/paths.ts` (Phase 1) |
| Error class for stale read | Custom error | `EDBStaleEntityReadError` from `src/errors/classes.ts` (Phase 1) |
| Error class for self-read | Custom error | `EDBSelfReadInMigrationError` from `src/errors/classes.ts` (Phase 1) |
| Entity name extraction | Parsing the migration ID | `entity.model.entity` (already used in apply-flow.ts:132) |
| Unguarded client binding | New DDB client creation | Pass `docClient` from `ApplyFlowArgs` — it is already the unguarded bundle client |

**Key insight:** All seven primitives that Phase 6 depends on were built in Phases 1-4 specifically to be consumed by this phase. The Phase 6 build is primarily composition and wiring, not net-new engineering.

---

## Common Pitfalls

### Pitfall 1: `entity.setClient` mutation contaminates the user's entity reference
**What goes wrong:** Calling `entity.setClient(docClient)` on the user-imported entity binds it to the unguarded client globally. Any other code that holds a reference to the same entity object (e.g., the frozen `v1.ts`/`v2.ts` entity used in rollback) will now use the unguarded client. This is an implicit global mutation.
**Why it happens:** `setClient` is an in-place mutation, not a factory (verified: entity.js line 1381).
**How to avoid:** Always use `new Entity(entity.schema, { client, table })` to create a new instance. [VERIFIED: entity.js line 1381-1384]
**Warning signs:** If rollback strategies start issuing DDB calls that bypass the guard unexpectedly, this mutation has occurred.

### Pitfall 2: `query` and `scan` namespace binding
**What goes wrong:** ElectroDB's `entity.query` is a namespace object (`{ byId: fn, ... }`), not a callable function. Calling `.bind(entity)` on it produces unexpected behavior. Passing `{ query: entity.query.bind(entity) }` in the facade would not preserve the namespace structure.
**Why it happens:** ElectroDB lazily builds `query` as a plain object in the constructor (entity.js line 82-86).
**How to avoid:** In the facade, reference `query` and `scan` as property references from the bound entity: `query: boundEntity.query`. The `boundEntity` reference ensures `this` is correct for any internal chaining.
**Warning signs:** `ctx.entity(Team).query.byId({...}).go()` throwing `TypeError: not a function`.

### Pitfall 3: Snapshot path for entities not yet baselined
**What goes wrong:** If a user imports an entity in `reads` but has not run `baseline` or `create`, the snapshot file does not exist. `readEntitySnapshot` throws `EDBSnapshotMalformedError` with a "cannot read snapshot file" message.
**Why it happens:** The `ctx.entity(Y)` fingerprint check reads `.electrodb-migrations/snapshots/Y.snapshot.json`. If the user never ran `baseline` or `create` for Y, this file is absent.
**How to avoid:** The runner should wrap the fingerprint pre-flight in a try/catch and re-surface `EDBSnapshotMalformedError` with a clear remediation message: "Run `electrodb-migrations baseline` to create a snapshot for entity Y."
**Warning signs:** `EDBSnapshotMalformedError` thrown with path including `.snapshot.json`.

### Pitfall 4: Down function injection in rollback strategies
**What goes wrong:** Phase 5's `executeProjected`, `executeFillOnly`, and `executeCustom` call `migration.down(v2Record)` with a single argument. CTX-01 states `down()` receives a second `ctx` argument. If the rollback orchestrator builds `ctx` but the strategy executors don't pass it to `down()`, `ctx.entity(Y)` would be undefined inside `down()`.
**Why it happens:** Phase 5 was built without Phase 6's `ctx` parameter. The `down` call signature in the strategy executors uses `migration.down(record)`, not `migration.down(record, ctx)`.
**How to avoid:** Phase 6 must update the rollback orchestrator to call `buildCtx` and pass `ctx` through to the strategy executors' `down()` calls. Check all four strategy executors for `migration.down(...)` calls and add the `ctx` argument.
**Warning signs:** `ctx` is `undefined` inside `down()` in tests; `ctx.entity(Y)` throws `TypeError: Cannot read properties of undefined`.

### Pitfall 5: Fingerprint mismatch when entity has no snapshot (fresh project)
**What goes wrong:** In a test environment where `baseline` was not run, no snapshot files exist. The eager pre-flight fails for every declared `reads` target.
**Why it happens:** Integration tests create tables dynamically; they do NOT run `baseline` before applying migrations.
**How to avoid:** Integration tests for cross-entity reads must either (a) create snapshot files explicitly in the test setup before calling `applyBatch`, or (b) use a migration fixture with no declared `reads` for the fingerprint-mismatch case, relying on a pre-created snapshot file in the test helpers.
**Warning signs:** All cross-entity read integration tests fail at the pre-flight stage with file-not-found errors.

### Pitfall 6: CTX-08 appliedAt comparison reliability
**What goes wrong:** "Applied since M" comparison using `appliedAt` timestamps may break if clocks skew between machines (e.g., two developers apply migrations on different machines to the same table). `appliedAt` is an ISO string written by the runner; string comparison is only reliable if the times are from the same clock source.
**Why it happens:** `appliedAt` is based on `Date.now()` at apply time, which is machine-local.
**How to avoid:** For CTX-08, compare migration sequence rather than timestamps. A migration on reads-target entity Y that has `status=applied|finalized` and whose `fromVersion` is ≥ the version at which M was authored is the precise definition of "applied since M". The `fromVersion` of Y's migrations is sequence-monotonic and comparison-safe. Use sequence ordering (fromVersion numeric) rather than timestamp ordering.
**Warning signs:** CTX-08 check fails spuriously when two developers apply migrations from different machines in quick succession.

---

## Code Examples

### Complete `buildCtx` call site in `applyFlowScanWrite`

```typescript
// src/runner/apply-flow.ts (modification)
// Source: existing code; ctx injection is the new addition

import { buildCtx } from '../ctx/index.js';

export async function applyFlowScanWrite(args: ApplyFlowArgs): Promise<ApplyFlowResult> {
  const audit = createCountAudit();

  // ... existing _migrations row creation ...

  // Phase 6: build ctx for cross-entity reads.
  // docClient is the unguarded bundle client; cwd from config or process.cwd().
  const ctx = await buildCtx(args.migration, args.client, args.tableName, args.cwd ?? process.cwd());

  for await (const page of iterateV1Records(args.migration)) {
    for (const v1 of page) {
      audit.incrementScanned();
      let v2: unknown;
      try {
        v2 = await args.migration.up(v1, ctx);  // ctx is now MigrationCtx, not unknown
      } catch (err) {
        audit.incrementFailed();
        throw err;
      }
      // ... rest unchanged ...
    }
  }
  // ...
}
```

Note: `args.cwd` needs to be added to `ApplyFlowArgs`. Alternatively, `buildCtx` can accept an explicit `snapshotRootDir` param derived from `config.root` or `process.cwd()`.

### `ReadOnlyEntityFacade<E>` type definition

```typescript
// src/ctx/types.ts
import type { AnyElectroEntity } from '../migrations/types.js';

// Extracts the return type of Entity.get(), .query, .scan, etc.
// The generic E lets callers get typed returns from a typed entity.
export interface ReadOnlyEntityFacade<E extends AnyElectroEntity> {
  get: E['get'];
  query: E['query'];
  scan: E['scan'];
  find: E['find'];
  match: E['match'];
  parse: E['parse'];
  // Write methods throw — typed as `never` to prevent TypeScript from thinking these work.
  put: never;
  create: never;
  upsert: never;
  update: never;
  patch: never;
  delete: never;
  remove: never;
}

export interface MigrationCtx {
  entity<E extends AnyElectroEntity>(other: E): ReadOnlyEntityFacade<E>;
}
```

**Note on `never` for write methods:** Typing write methods as `never` makes the TypeScript compiler refuse `ctx.entity(Team).put(...)` at compile time as well as at runtime. This is the ideal type-safe approach. However, it may produce confusing error messages at the type level. The alternative is to type them as `() => never` (callable but return never) which gives a better error message at the call site. Either approach is valid; the planner should choose one and be consistent.

---

## Runtime State Inventory

Phase 6 is not a rename/refactor/migration phase. No runtime state inventory needed.

However, the following DDB state is written/read by Phase 6's changes:

| What | Existing or New | Notes |
|------|-----------------|-------|
| `_migrations.reads` (Set<string>) | Existing (Phase 3 schema, Phase 4 write) | Phase 6 reads this in CTX-08 precondition check; already being written at apply time |
| Snapshot files `.electrodb-migrations/snapshots/*.snapshot.json` | Existing (Phase 1/2) | Phase 6 reads these for fingerprint validation; no new writes |

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | ✓ | 22.21.1 | — |
| Docker | DDB Local for integration tests | ✓ | 27.4.0 | — |
| Docker Compose | DDB Local startup | ✓ | v2.31.0-desktop.2 | — |
| DDB Local (running) | Integration tests | ✗ (not running) | — | `docker compose up -d dynamodb-local` before tests |
| pnpm | Package management | ✓ | 10.14.0 | — |

**Missing dependencies with no fallback:**
- DDB Local must be started before running integration tests: `docker compose up -d dynamodb-local`.

**Missing dependencies with fallback:**
- None.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.x (pinned `^2.1.0` per CLAUDE.md) |
| Config file | `vitest.config.ts` at project root |
| Quick run command | `pnpm test --reporter=verbose --testNamePattern="CTX"` |
| Full suite command | `pnpm test && pnpm test:integration` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CTX-01 | `up()` and `down()` receive `ctx` second arg | unit | `pnpm test tests/unit/ctx/build-ctx.test.ts` | ❌ Wave 0 |
| CTX-02 | `ctx.entity(Other)` returns facade bound to unguarded client | integration | `pnpm test:integration tests/integration/ctx/ctx-read.test.ts` | ❌ Wave 0 |
| CTX-03 | Write methods on facade throw before DDB | unit | `pnpm test tests/unit/ctx/read-only-facade.test.ts` | ❌ Wave 0 |
| CTX-04 | `ctx.entity(SelfEntity)` throws `EDBSelfReadInMigrationError` | unit | `pnpm test tests/unit/ctx/build-ctx.test.ts -t "self-read"` | ❌ Wave 0 |
| CTX-05 | Fingerprint mismatch throws `EDBStaleEntityReadError` | unit + integration | `pnpm test tests/unit/ctx/build-ctx.test.ts -t "stale"` | ❌ Wave 0 |
| CTX-06 | `reads` persisted on `_migrations` row | integration | `pnpm test:integration tests/integration/ctx/ctx-audit-row.test.ts` | ❌ Wave 0 |
| CTX-07 | (Phase 7 scope) | — | — | — |
| CTX-08 | Rollback refused when reads-target has later applied migration | unit + integration | `pnpm test tests/unit/rollback/preconditions-ctx08.test.ts` | ❌ Wave 0 |

**Integration test coverage matrix (SC-5):** four declared/undeclared × in-bounds/out-of-bounds cases:
| Case | Description | Expected |
|------|-------------|----------|
| declared + in-bounds | `reads: [Team]`, Team snapshot matches | `ctx.entity(Team).get()` succeeds |
| declared + out-of-bounds | `reads: [Team]`, Team snapshot mismatch (older) | `buildCtx` throws `EDBStaleEntityReadError` |
| undeclared + in-bounds | no `reads`, Team snapshot matches | `ctx.entity(Team).get()` succeeds (lazy validation passes) |
| undeclared + out-of-bounds | no `reads`, Team snapshot mismatch | `ctx.entity(Team)` throws `EDBStaleEntityReadError` at call time |

### Sampling Rate

- **Per task commit:** `pnpm test tests/unit/ctx/ --reporter=dot`
- **Per wave merge:** `pnpm test && pnpm test:integration`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/unit/ctx/build-ctx.test.ts` — covers CTX-01, CTX-04, CTX-05 unit scenarios
- [ ] `tests/unit/ctx/read-only-facade.test.ts` — covers CTX-02, CTX-03 unit scenarios
- [ ] `tests/unit/rollback/preconditions-ctx08.test.ts` — covers CTX-08 unit scenarios
- [ ] `tests/integration/ctx/ctx-read.test.ts` — covers SC-1, SC-2, SC-5 integration
- [ ] `tests/integration/ctx/ctx-audit-row.test.ts` — covers CTX-06, SC-4 integration
- [ ] `tests/_helpers/sample-migrations/User-reads-Team/` — new fixture migration that declares `reads: [Team]` and uses `ctx.entity(Team).get(...)` in `up()`
- [ ] Framework install: no new packages needed

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | yes — write gate | Facade throws on all write methods before any DDB call |
| V5 Input Validation | yes — entity name | `entitySnapshotPath` validates entity name has no path separators (verified: `snapshot/paths.ts:47-52`) |
| V6 Cryptography | yes — fingerprint | SHA-256 via `fingerprintEntityModel` — standard `node:crypto` |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Write bypass via ctx | Tampering | Facade write methods throw before any DDB call — enforced at the facade layer, not at the DDB client layer |
| Path traversal via entity name | Tampering | `entitySnapshotPath` validates `!includes('/')`, `!includes('..')` (existing check) |
| Stale schema read (shape mismatch) | Information Disclosure | `EDBStaleEntityReadError` thrown before the first `GetItem` — per-run at eager pre-flight |
| Self-read deadlock/incoherence | Tampering | `EDBSelfReadInMigrationError` thrown at `ctx.entity(Self)` call, before any DDB call |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Fingerprints should be validated eagerly at `buildCtx` time for declared reads, lazily for undeclared | OQ4 | If wrong: stale reads could slip through for undeclared entities; planner should confirm eager-for-declared is the right boundary |
| A2 | `_migrations.reads` stays as `Set<string>` (names only, no fingerprints) | OQ2 | If wrong: Phase 7's validate gate cannot compare fingerprints without a schema change; low risk given validate only needs ordering |
| A3 | CTX-08 uses migration sequence ordering (fromVersion) rather than `appliedAt` timestamp | Pitfall 6 | If wrong: CTX-08 check may produce false positives in multi-developer environments; low risk since ordering is the semantic intent |
| A4 | `new Entity(entity.schema, { client, table })` creates a fully functional copy bound to the new client | OQ1 | If wrong: the facade approach fails and Proxy or setClient+clone must be used; HIGH risk, must be verified in Wave 0 spike test |
| A5 | `query` and `scan` are namespace objects that must be referenced directly, not bound | OQ1 pitfall | If wrong: `boundEntity.query.byId({}).go()` fails; must be covered by a unit test |
| A6 | `down()` in rollback strategy executors needs `ctx` passed as second argument | Pitfall 4 | If wrong: cross-entity reads inside `down()` fail with undefined ctx; HIGH risk, must be part of the Phase 6 scope |
| A7 | Typing write methods as `never` is the correct TypeScript approach | Code Examples | If wrong: the type definition change would be needed in Phase 10 cleanup; low risk |

---

## Open Questions

1. **`ApplyFlowArgs.cwd` addition**
   - What we know: `buildCtx` needs `cwd` to call `entitySnapshotPath`. `applyFlow` does not currently take a `cwd` argument.
   - What's unclear: Should `cwd` come from `args.config` (does `ResolvedConfig` carry a `root` or `cwd` field?), or should it be added as a new field on `ApplyFlowArgs`?
   - Recommendation: Check `ResolvedConfig` for an existing `root`/`cwd` field. If none, add `cwd: string` to `ApplyFlowArgs` and pass it from `MigrationsClient.apply()` (which already has `const cwd = args.cwd ?? process.cwd()`).

2. **`down()` ctx injection in rollback strategy executors**
   - What we know: Phase 5's `executeProjected`, `executeFillOnly`, `executeCustom` call `migration.down(v2)` with one argument. CTX-01 says `down()` receives `ctx`.
   - What's unclear: Should the rollback orchestrator call `buildCtx` (with fingerprint pre-flight) before executing the strategy? Or should `down()` receive a `null`/stub ctx that throws with "cross-entity reads not supported in rollback path"?
   - Recommendation: Full `buildCtx` in the rollback orchestrator, just as in `applyFlowScanWrite`. Cross-entity reads in `down()` are valid use cases (e.g., undoing a denormalization that required a cross-entity read in `up()`).

3. **`new Entity(schema, config)` clone verification**
   - What we know: ElectroDB's Entity constructor accepts `schema` + `config` (verified in docs). The `schema` property is exposed as `entity.schema` (verified: index.d.ts line 5466).
   - What's unclear: Does constructing `new Entity(entity.schema, { client, table })` produce a fully functional entity (with all query/scan chains working), or does the constructor do internal processing that depends on the original `config` object?
   - Recommendation: Add a Wave 0 spike test that constructs a test entity, clones it with a different client via `new Entity(entity.schema, { client, table })`, and verifies `boundEntity.get({id: 'test'}).params()` returns correct params. This must pass before committing to the approach.

---

## Sources

### Primary (HIGH confidence)
- `src/runner/apply-flow.ts` — `ctx` threading (line 22, 143), `reads` persistence (line 130-133)
- `src/migrations/types.ts` — `Migration.reads` field (line 88), `AnyElectroEntity` type
- `src/internal-entities/migrations.ts` — `_migrations.reads` DDB schema (line 94)
- `src/safety/fingerprint-projection.ts` — `fingerprintEntityModel` API
- `src/snapshot/read.ts` — `readEntitySnapshot` API
- `src/snapshot/paths.ts` — `entitySnapshotPath` API (including path-traversal validation)
- `src/errors/classes.ts` — `EDBStaleEntityReadError`, `EDBSelfReadInMigrationError` (lines 53-64)
- `src/errors/codes.ts` — stable error codes
- `src/guard/wrap.ts` — `runUnguarded`, unguarded `docClient` pattern
- `src/client/create-migrations-client.ts` — middleware stack isolation, `docClient` vs `guardedDocClient`
- `src/rollback/preconditions.ts` — CTX-08 insertion point (structure verified)
- `.research/electrodb/src/entity.js` — `getName()` (line 138), `setClient` (line 1381), `ownsItem` (line 146), `query` namespace initialization (line 82)
- `.research/electrodb/index.d.ts` — `Entity` class definition (line 5459), full method list (lines 5470-5769), `setClient` (line 5768), `schema` property (line 5466)
- `README.md §6.6` — cross-entity reads documentation contract (lines 770-817)

### Secondary (MEDIUM confidence)
- `ElectroDB docs (ctx7)` — Entity constructor options, `get`/`query`/`scan`/`batchGet`/`find`/`match` method shapes — [CITED: context7 /tywalch/electrodb]

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all primitives verified in source
- Integration seams: HIGH — every seam verified against actual source files
- Architecture: HIGH (patterns) / MEDIUM (A4 — `new Entity(schema)` clone approach needs spike validation)
- Pitfalls: HIGH — all pitfalls derived from source inspection
- CTX-08 implementation: MEDIUM — preconditions structure is clear; exact fromVersion comparison logic is not yet in source

**Research date:** 2026-05-09
**Valid until:** 2026-06-09 (30 days — stable library stack; only internal codebase changes would invalidate)
