# Phase 6: Cross-Entity Reads — Pattern Map

**Mapped:** 2026-05-09
**Files analyzed:** 20 new/modified files
**Analogs found:** 19 / 20

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/ctx/types.ts` | type-definitions | — | `src/migrations/types.ts` | exact |
| `src/ctx/build-ctx.ts` | factory/service | request-response | `src/runner/apply-flow.ts` (`applyFlowScanWrite`) | role-match |
| `src/ctx/read-only-facade.ts` | utility | transform | `src/guard/wrap.ts` (`runUnguarded` / middleware bypass) | role-match |
| `src/ctx/index.ts` | barrel | — | `src/migrations/index.ts` | exact |
| `src/runner/apply-flow.ts` | runner (modify) | CRUD | self (existing file) | exact |
| `src/runner/finalize-flow.ts` | runner (assess) | CRUD | self (existing file) | exact |
| `src/rollback/orchestrator.ts` | orchestrator (modify) | CRUD | self (existing file) | exact |
| `src/rollback/preconditions.ts` | precondition-gate (modify) | request-response | self (existing file) | exact |
| `src/rollback/strategies/{projected,fill-only,custom}.ts` | strategy (modify) | transform | `src/rollback/strategies/projected.ts` | exact |
| `src/migrations/types.ts` | type-definitions (modify) | — | self (existing file) | exact |
| `src/errors/codes.ts` | constants (modify) | — | self (existing file) | exact |
| `tests/unit/ctx/build-ctx.test.ts` | unit test | request-response | `tests/unit/rollback/preconditions.test.ts` | exact |
| `tests/unit/ctx/read-only-facade.test.ts` | unit test | transform | `tests/unit/safety/consistent-read.test.ts` | role-match |
| `tests/unit/ctx/_helpers.ts` | test utility | — | `tests/unit/rollback/_stub-service.ts` | exact |
| `tests/unit/rollback/preconditions-ctx08.test.ts` | unit test | request-response | `tests/unit/rollback/preconditions.test.ts` | exact |
| `tests/integration/ctx/ctx-read.test.ts` | integration test | CRUD | `tests/integration/rollback/std-classify.test.ts` | role-match |
| `tests/integration/ctx/ctx-audit-row.test.ts` | integration test | CRUD | `tests/integration/rollback/audit-row-shape.test.ts` | role-match |
| `tests/integration/rollback/ctx08-refusal.test.ts` | integration test | request-response | `tests/integration/rollback/lock-cycle.test.ts` | role-match |
| `tests/_helpers/sample-migrations/User-reads-Team/` | fixture migration | CRUD | `tests/_helpers/sample-migrations/User-and-Team-std/` | exact |
| `tests/_helpers/sample-migrations/User-self-read/` | fixture migration (CTX-04) | — | `tests/_helpers/sample-migrations/User-add-status/` | exact |

---

## Pattern Assignments

---

### `src/ctx/types.ts` (type-definitions)

**Analog:** `src/migrations/types.ts`

**Why:** Same role — a types-only module that defines the public interface consumed by user-authored functions and by the runner. `Migration<From, To>` is the exact precedent for `MigrationCtx`.

**Conventions:**
- Module-level JSDoc block describing the type, the phase that introduces it, and the downstream consumer.
- `AnyElectroEntity` is already defined in `src/migrations/types.ts` — import it from there; do not re-define.
- Use `// biome-ignore` only for the one spot that requires `any` generics (ElectroDB's 5-parameter Entity).
- No runtime code in this file — types and interfaces only.

**Imports pattern** (from `src/migrations/types.ts` lines 1–16):
```typescript
import type { Entity } from 'electrodb';

// biome-ignore lint/suspicious/noExplicitAny: Required to reference ElectroDB's generic Entity<A, F, C, S, P> without forcing schema generics through the public Migration surface.
export type AnyElectroEntity = Entity<any, any, any, any>;
```

**Core pattern for `MigrationCtx` interface:**
```typescript
// Type write methods as `() => never` (callable but return never) for the
// clearest TypeScript error at the call site. Typing as `never` (non-callable)
// gives a confusing "property does not exist" error in some IDE setups.
export interface ReadOnlyEntityFacade<E extends AnyElectroEntity> {
  get: E['get'];
  query: E['query'];
  scan: E['scan'];
  find: E['find'];
  match: E['match'];
  parse: E['parse'];
  put: () => never;
  create: () => never;
  upsert: () => never;
  update: () => never;
  patch: () => never;
  delete: () => never;
  remove: () => never;
}

export interface MigrationCtx {
  entity<E extends AnyElectroEntity>(other: E): ReadOnlyEntityFacade<E>;
}
```

**Pitfalls:**
- Do NOT put `batchGet` in the facade type — ElectroDB's `batchGet` is defined on the `Entity` class, but its return type and call signature differ by ElectroDB version. Include it in the runtime facade (via `(boundEntity as any).batchGet`) but omit from `ReadOnlyEntityFacade<E>` unless the type inference works cleanly. Leave it as `any` typed on the facade implementation and add a TODO for Phase 8 tightening.
- `E['query']` is a namespace object type, not a function type. This is correct — TypeScript will see it as the index namespace type. Do not try to narrow it to `(...) => ...`.

---

### `src/ctx/build-ctx.ts` (factory/service, request-response)

**Analog:** `src/runner/apply-flow.ts` (`applyFlowScanWrite` function, lines 103–175)

**Why:** `buildCtx` is the pre-flight factory that validates preconditions before any DDB call — the same role that `applyFlowScanWrite` serves for the apply path (it creates the `_migrations` audit row before the scan loop). Both perform an eagerly-executed setup step that must succeed before the main operation proceeds.

**Conventions:**
- `.js` extension on all relative imports (ESM, no exceptions). E.g. `import { fingerprintEntityModel } from '../safety/fingerprint-projection.js'`.
- Async function returning a typed value.
- JSDoc that cites the RESEARCH section and the requirement IDs (CTX-01, CTX-04, CTX-05, OQ4).
- All error construction follows the existing pattern: `new EDBStaleEntityReadError(message, detailsObject)` — the base class accepts `(message, details)` at construction time. Verify the base class constructor signature from `src/errors/base.ts` before coding.

**Imports pattern** (from `src/runner/apply-flow.ts` lines 1–10):
```typescript
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import { MIGRATIONS_SCHEMA_VERSION, type MigrationsServiceBundle } from '../internal-entities/index.js';
import { acquireLock, startLockHeartbeat } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
```

For `build-ctx.ts` the imports will be:
```typescript
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
import { readEntitySnapshot } from '../snapshot/read.js';
import { entitySnapshotPath } from '../snapshot/paths.js';
import { EDBStaleEntityReadError, EDBSelfReadInMigrationError } from '../errors/index.js';
import { createReadOnlyFacade } from './read-only-facade.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { MigrationCtx } from './types.js';
```

**Core pattern — eager pre-flight + lazy fallback** (derived from RESEARCH §Pattern 1):
```typescript
export async function buildCtx(
  migration: Migration<AnyElectroEntity, AnyElectroEntity>,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  cwd: string,
): Promise<MigrationCtx> {
  // Cache: Map<entityName, ReadOnlyEntityFacade>
  const cache = new Map<string, ReturnType<typeof createReadOnlyFacade>>();

  // Eager pre-flight for declared reads targets (OQ4 / CTX-05)
  for (const entity of migration.reads ?? []) {
    const entityName = (entity as unknown as { model: { entity: string } }).model.entity;
    // Self-read declared in reads array — catch early (OQ3 / CTX-04)
    if (entityName === migration.entityName) {
      throw new EDBSelfReadInMigrationError(...);
    }
    // Fingerprint validation against on-disk snapshot
    const snapshotPath = entitySnapshotPath(cwd, entityName);
    const snapshot = readEntitySnapshot(snapshotPath);  // throws EDBSnapshotMalformedError if file absent
    const { fingerprint: importedFingerprint } = fingerprintEntityModel((entity as any).model);
    if (snapshot.fingerprint !== importedFingerprint) {
      throw new EDBStaleEntityReadError(...);
    }
    cache.set(entityName, createReadOnlyFacade(entity, docClient, tableName));
  }

  return {
    entity<E extends AnyElectroEntity>(other: E): ReturnType<typeof createReadOnlyFacade> {
      // ... self-read check + cache lookup + lazy validation
    },
  } as MigrationCtx;
}
```

**Error handling pattern** (from `src/runner/apply-flow.ts` lines 54–85):
- Errors thrown by `buildCtx` are NOT caught inside `buildCtx` — they propagate to `applyFlowScanWrite` where the existing try/catch calls `markFailed`. No new catch block needed inside `buildCtx`.
- `readEntitySnapshot` throws `EDBSnapshotMalformedError` when the file is absent (Pitfall 3 in RESEARCH). Wrap the `readEntitySnapshot` call in a try/catch that re-surfaces the error with a remediation message: `"Run \`electrodb-migrations baseline\` to create a snapshot for entity ${entityName}."`. This is the only new catch block inside `buildCtx`.

**Open question in RESEARCH §OQ-1 (`cwd` / `snapshotRootDir`):**
`ApplyFlowArgs` does not currently have a `cwd` field. Check `ResolvedConfig` for an existing `root` or `cwd` field. If none exists, add `cwd: string` to `ApplyFlowArgs` and pass it from `MigrationsClient.apply()` (which already has `const cwd = args.cwd ?? process.cwd()`). The same `cwd` extension applies to `RollbackArgs`.

**Pitfalls:**
- Pitfall 1 (RESEARCH): Never call `entity.setClient(docClient)` — it mutates the user's imported entity globally. Always use `new Entity(entity.schema, { client, table })` via `createReadOnlyFacade`.
- Pitfall 3 (RESEARCH): `readEntitySnapshot` throws when the snapshot file is absent. Catch and re-surface with a clear remediation message pointing to `baseline`.
- Pitfall 5 (RESEARCH): Integration tests that don't run `baseline` first will see pre-flight failures. Integration test setup must write snapshot files explicitly before calling `applyFlow`.

---

### `src/ctx/read-only-facade.ts` (utility, transform)

**Analog:** `src/guard/wrap.ts` (the `runUnguarded` + middleware approach)

**Why:** Both are pure utility wrappers that modify DDB client behavior without the caller needing to know the implementation. `wrap.ts` attaches middleware to intercept all DDB calls; `read-only-facade.ts` wraps an Entity with a different client and blocks write methods. Similar "interception at a layer" pattern.

**Conventions:**
- No ElectroDB imports with the full generic tuple — use `(entity as any).schema` consistently for the clone call. The `biome-ignore` comment is required per the pattern in `src/migrations/types.ts`.
- Function named `createReadOnlyFacade` (not a class). Returns a plain object (not a class instance).
- Write-trap function is a private helper inside the module (`function makeWriteThrow`); not exported.
- Error message for write traps uses the `[electrodb-migrations]` prefix (see the convention in `src/runner/apply-flow.ts` console.error calls at lines 62, 79).

**Core pattern** (from RESEARCH §Pattern 2):
```typescript
import { Entity } from 'electrodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AnyElectroEntity } from '../migrations/types.js';

function makeWriteThrow(method: string): () => never {
  return (): never => {
    throw new Error(
      `[electrodb-migrations] ctx.entity().${method}() — ctx is read-only. ` +
      `Writes through ctx are not permitted. Return the transformed record from up() instead.`
    );
  };
}

export function createReadOnlyFacade(
  entity: AnyElectroEntity,
  client: DynamoDBDocumentClient,
  tableName: string,
) {
  // Clone the entity bound to the unguarded client.
  // new Entity(schema, config) creates a fresh instance — does NOT mutate the user's entity.
  const boundEntity = new Entity(
    (entity as any).schema,
    { client, table: tableName },
  );

  return {
    get: boundEntity.get.bind(boundEntity),
    query: boundEntity.query,    // namespace object — reference directly (Pitfall 2)
    scan: boundEntity.scan,      // namespace object — reference directly (Pitfall 2)
    find: boundEntity.find.bind(boundEntity),
    match: boundEntity.match.bind(boundEntity),
    parse: boundEntity.parse.bind(boundEntity),
    // batchGet: (boundEntity as any).batchGet — include in runtime, omit from type
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

**Pitfalls:**
- Pitfall 2 (RESEARCH): `entity.query` and `entity.scan` are namespace objects in ElectroDB, not callable functions. Using `.bind(boundEntity)` on them produces a bound function wrapping the namespace object, NOT a bound namespace. Reference them directly as `boundEntity.query` and `boundEntity.scan`.
- Assumption A4 (RESEARCH): The `new Entity(entity.schema, { client, table })` clone approach must be validated by a Wave 0 spike test (`boundEntity.get({id:'test'}).params()` returns correct params). If the clone does not produce a functional entity, the facade approach must be revisited and the planner should flag this as a Wave 0 blocker.
- The write-trap functions (`makeWriteThrow`) return `() => never`, not `() => void`. The TypeScript return type `never` is important — it makes the facade type express that calling these methods is a type error.

---

### `src/ctx/index.ts` (barrel)

**Analog:** `src/migrations/index.ts` (lines 1–2)

**Why:** Exact match — a minimal named-export barrel for a small module directory.

**Conventions:**
- Named exports only — never `export *`.
- Export runtime values (`buildCtx`, `createReadOnlyFacade`) as values.
- Export types with the `export type` keyword (`MigrationCtx`, `ReadOnlyEntityFacade`).
- Comment at the top: `// Pattern: name every symbol explicitly; never \`export *\`.`

```typescript
// Pattern: name every symbol explicitly; never `export *`.
export { buildCtx } from './build-ctx.js';
export { createReadOnlyFacade } from './read-only-facade.js';
export type { MigrationCtx, ReadOnlyEntityFacade } from './types.js';
```

---

### `src/runner/apply-flow.ts` (runner, modification)

**Analog:** Self — the file being modified.

**Key modification points:**

1. **`ApplyFlowArgs` interface** (line 12–22): Add `cwd?: string` field alongside the `ctx?: unknown` comment. Add a JSDoc comment noting Phase 6 wires `buildCtx` here.

2. **`applyFlowScanWrite` function** (line 103): Import `buildCtx` from `'../ctx/index.js'`. Replace `args.ctx` with the result of `buildCtx(...)` called before the scan loop, after the `_migrations` row PUT. Replace `ctx?: unknown` type with `ctx?: MigrationCtx`. The call site is:
```typescript
import { buildCtx } from '../ctx/index.js';
// ...
const ctx = await buildCtx(
  args.migration,
  args.client,
  args.tableName,
  args.cwd ?? process.cwd(),
);
// ... then pass ctx to up():
v2 = await args.migration.up(v1, ctx);
```

3. **`up()` call at line 143**: Already `args.migration.up(v1, args.ctx)` — change `args.ctx` to `ctx` (the built ctx).

**Conventions:** Preserve the existing JSDoc comment structure. Add Phase 6 annotation to the JSDoc of `applyFlowScanWrite`. Follow the existing `// Phase N: ` comment convention used at line 131 (`// Phase 3 deltas`-style inline comments are used elsewhere).

**Pitfall from apply-flow history:** The `_migrations` row PUT at lines 119–135 uses `as never` cast for the put argument. This is an existing pattern — do not change it. The `as never` is deliberate (ElectroDB schema strict-mode workaround for the `kind` literal type).

---

### `src/runner/finalize-flow.ts` (runner, assess-only)

**Analog:** Self — assess whether `ctx` injection is needed.

**Assessment (from RESEARCH §Integration Seams):** `finalize` does NOT call `up()` or `down()`. It scans and deletes v1 records under maintenance-mode lock. Therefore `finalize-flow.ts` does NOT need `ctx` injection. No change required in Phase 6.

**If a future requirement asks `finalizeFlow` to call user code, the pattern to follow would be the same `buildCtx(...)` call before the scan loop** — but that is out of Phase 6 scope.

---

### `src/rollback/orchestrator.ts` (orchestrator, modification)

**Analog:** Self — the file being modified.

**Key modification points** (from RESEARCH §Pitfall 4 and §Open Question 2):

The rollback orchestrator calls strategy executors that internally call `migration.down(v2Record)`. Phase 6 must pass `ctx` as the second argument. The modification has two parts:

1. **`RollbackArgs` interface** (line 77–90): Add `cwd?: string` field alongside the existing fields.

2. **Inside the `rollback` function after `sleep(acquireWaitMs)`** (before the case dispatch at line 190): Build ctx using `buildCtx` from `'../ctx/index.js'`. Pass `ctx` to each strategy executor:
```typescript
import { buildCtx } from '../ctx/index.js';
// ...
const ctx = await buildCtx(
  args.migration,
  args.client,
  args.tableName,
  args.cwd ?? process.cwd(),
);
// then pass ctx to executeProjected, executeFillOnly, executeCustom
await executeProjected({ ..., ctx });
```

3. **Strategy executor signatures** must accept `ctx` and forward it to `migration.down(record, ctx)`. See the strategy modifier section below.

**Conventions:** Preserve the extensive JSDoc at the top of the file. Add `Phase 6:` annotation to the function-level JSDoc. The `markFailed` catch block pattern (lines 273–280) must not be changed — `buildCtx` errors propagate naturally through the existing catch block.

---

### `src/rollback/strategies/{projected,fill-only,custom}.ts` (strategies, modification)

**Analog:** `src/rollback/strategies/projected.ts` (self, for the pattern)

**Key modification:** Each strategy executor that calls `migration.down(record)` must add `ctx` as the second argument:
```typescript
// Before (Phase 5):
const v1 = await args.migration.down(record);
// After (Phase 6):
const v1 = await args.migration.down(record, args.ctx);
```

**`ExecuteProjectedArgs` / `ExecuteFillOnlyArgs` / `ExecuteCustomArgs` interfaces:** Add `ctx: MigrationCtx` field.

**Conventions:** The strategy executor files follow a consistent pattern: an `Args` interface, an `execute` function, and the strategy logic. Follow the existing pattern exactly.

**Pitfall from Phase 5 (Pitfall 3 in RESEARCH):** Phase 5's `custom` strategy had a pitfall where schema-validation was initially missed. For Phase 6, the parallel pitfall is passing `ctx` to `down()` in all three executors, not just one. Check all three files: `projected.ts`, `fill-only.ts`, `custom.ts`. The `snapshot` strategy does NOT call `down()` — it does not need `ctx`.

---

### `src/migrations/types.ts` (type-definitions, modification)

**Analog:** Self — tighten the `ctx?: unknown` type on `up` and `down`.

**Key modification** (line 84 and 86):
```typescript
// Before:
up: (record: unknown, ctx?: unknown) => Promise<unknown>;
down?: (record: unknown, ctx?: unknown) => Promise<unknown>;
// After:
up: (record: unknown, ctx?: MigrationCtx) => Promise<unknown>;
down?: (record: unknown, ctx?: MigrationCtx) => Promise<unknown>;
```

Import `MigrationCtx` from `'../ctx/types.js'`. Use `import type` to avoid circular dependencies.

**Pitfall:** Introducing `import type { MigrationCtx } from '../ctx/types.js'` from `src/migrations/types.ts` creates a new inter-module dependency. Verify there is no circular import: `ctx/types.ts` imports from `migrations/types.ts` (`AnyElectroEntity`). If `migrations/types.ts` imports from `ctx/types.ts`, that IS a cycle. Resolution: define `MigrationCtx` in `ctx/types.ts` only as a type that is referenced but NOT imported from `migrations/types.ts`. Instead, keep `ctx?: unknown` in `migrations/types.ts` and only tighten the type at the `defineMigration` call site in `define.ts` using an overloaded or intersection type. Alternatively, move `MigrationCtx` to `migrations/types.ts` directly, since it is part of the migration contract. The planner must choose one path and document it.

---

### `src/errors/codes.ts` (constants, modification)

**Analog:** Self — add `READS_DEPENDENCY_APPLIED` to `ROLLBACK_REASON_CODES`.

**Pattern** (from `src/errors/codes.ts` lines 27–31):
```typescript
export const ROLLBACK_REASON_CODES = {
  NO_DOWN_FUNCTION: 'NO_DOWN_FUNCTION',
  NO_RESOLVER: 'NO_RESOLVER',
  FINALIZED_ONLY_PROJECTED: 'FINALIZED_ONLY_PROJECTED',
  READS_DEPENDENCY_APPLIED: 'READS_DEPENDENCY_APPLIED',  // Phase 6 — CTX-08
} as const;
```

The `RollbackReasonCode` type is a `(typeof ROLLBACK_REASON_CODES)[keyof typeof ROLLBACK_REASON_CODES]` union — it updates automatically when the new key is added.

**Convention:** SCREAMING_SNAKE_CASE. Keys and values match. No `EDB_` prefix (sub-codes inside `EDB_ROLLBACK_NOT_POSSIBLE`).

---

### `src/rollback/preconditions.ts` (precondition-gate, modification)

**Analog:** Self — add Step 10 (CTX-08) to `checkPreconditions`.

**Position:** After Step 9 (capability checks, line 169) and before the final `return { kind: 'proceed' }` (line 172). This matches RESEARCH §OQ7's explicit instruction: "Add as Step 10 after the existing strategy/capability checks (Step 9, line 150)".

**Pattern** (from the existing Step 5 head-only check, lines 111–121):
```typescript
// Step 10: CTX-08 — refuse if any migration on a reads target has been applied since M.
if (targetRow.reads && (targetRow.reads as Set<string>).size > 0) {
  const blockingMig = findBlockingReadsDependency(allRows, targetRow);
  if (blockingMig) {
    const err = new EDBRollbackNotPossibleError(
      `Cannot rollback ${args.migration.id}: migration ${blockingMig.id} on reads-target ` +
      `entity '${blockingMig.entityName}' has been applied since ${args.migration.id}. ` +
      `Roll back ${blockingMig.id} first.`,
      {
        reason: ROLLBACK_REASON_CODES.READS_DEPENDENCY_APPLIED,
        blockingMigration: blockingMig.id,
        readsDependency: blockingMig.entityName,
        migrationId: args.migration.id,
      },
    );
    (err as Error & { remediation?: string }).remediation =
      `Run \`rollback ${blockingMig.id}\` first, then re-run \`rollback ${args.migration.id}\`.`;
    return { kind: 'refuse', error: err };
  }
}
```

**`findBlockingReadsDependency` helper** (private function, same file): Takes `allRows: MigrationsRow[]` and `targetRow: MigrationsRow`. For each entity name in `targetRow.reads`, finds all rows with `entityName === readTarget && status ∈ {'applied', 'finalized'}`. Uses `fromVersion` numeric comparison (not `appliedAt` timestamp — Pitfall 6 in RESEARCH) to determine "applied since M":
- A row for the reads-target entity is "blocking" if its `fromVersion` (parsed as integer) is >= `targetRow.toVersion` (the version that target M migrated TO). This means a migration on the reads-target entity that starts from a version newer than what M read is blocking.

**Convention for the helper:** `function findBlockingReadsDependency` with `// private` annotation in the JSDoc section comment at the bottom of the file (matching the three existing `buildNotFoundError`, `buildAlreadyRevertedError`, `buildNotAppliedError` helpers at lines 183–209). The helper follows the same pattern: a private function at the bottom of the file with a JSDoc comment.

**Pitfall from Phase 5 (preconditions):** The `checkPreconditions` function already returns early for `case-1` (line 133). The CTX-08 check at Step 10 must NOT fire for `case-1` — it only makes sense for `case-2` and `case-3`. However, since `case-1` early-returns BEFORE Step 10, this is naturally correct if Step 10 is placed after Step 9 and before the `return { kind: 'proceed' }`. No additional guard needed.

---

### `tests/unit/ctx/build-ctx.test.ts` (unit test)

**Analog:** `tests/unit/rollback/preconditions.test.ts`

**Why:** Same test structure — pure logic gate tests with stub-injected data, no real DDB. `checkPreconditions` tests provide the precise pattern: stub service, inject rows, assert discriminated union results.

**Structure pattern** (from `tests/unit/rollback/preconditions.test.ts` lines 1–30):
```typescript
/**
 * Unit tests for `buildCtx` — covers CTX-01, CTX-04, CTX-05.
 *
 * RED phase: written before the implementation and expected to FAIL.
 *
 * CTX-04: ctx.entity(SelfEntity) throws EDBSelfReadInMigrationError
 * CTX-05: stale fingerprint throws EDBStaleEntityReadError
 * OQ3: entity name comparison via entity.model.entity
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCtx } from '../../../src/ctx/build-ctx.js';
import { EDBSelfReadInMigrationError, EDBStaleEntityReadError } from '../../../src/errors/index.js';
// ...

// Helper factories for stubs
function makeStubMigration(overrides?: Partial<{...}>): ... { ... }
function makeStubEntity(entityName: string): ... { ... }
function makeStubDocClient(): ... { ... }

describe('buildCtx', () => {
  describe('CTX-04: self-read detection', () => {
    it('throws EDBSelfReadInMigrationError when reads contains the migration entity name', async () => { ... });
    it('throws EDBSelfReadInMigrationError when ctx.entity(Self) is called at runtime', async () => { ... });
  });
  describe('CTX-05: fingerprint pre-flight', () => {
    it('throws EDBStaleEntityReadError when on-disk fingerprint mismatches imported entity', async () => { ... });
    it('passes when fingerprints match', async () => { ... });
  });
  describe('CTX-01: ctx.entity() returns a facade', () => { ... });
});
```

**Key convention for the helpers file:** Unit tests for `buildCtx` and `read-only-facade` need a `_helpers.ts` that provides stub entities, stub snapshot files (written to a temp dir), and stub `docClient`. See the `tests/unit/ctx/_helpers.ts` pattern below.

**Import paths:** Always use `.js` extension: `import { buildCtx } from '../../../src/ctx/build-ctx.js'`.

---

### `tests/unit/ctx/read-only-facade.test.ts` (unit test, transform)

**Analog:** `tests/unit/safety/consistent-read.test.ts` (structure) and `tests/unit/rollback/preconditions.test.ts` (assertion style)

**Why:** `consistent-read.test.ts` is a pure behavioural unit test for a utility module with no DDB involvement — closest match in spirit to the facade tests.

**Structure pattern:**
```typescript
/**
 * Unit tests for `createReadOnlyFacade` — covers CTX-02, CTX-03.
 *
 * RED phase: written before the implementation.
 *
 * CTX-02: facade methods delegate to the bound entity
 * CTX-03: write methods throw before hitting DDB
 */
import { describe, expect, it } from 'vitest';
import { createReadOnlyFacade } from '../../../src/ctx/read-only-facade.js';
import { makeStubEntity, makeStubDocClient } from './_helpers.js';

describe('createReadOnlyFacade', () => {
  describe('CTX-03: write methods throw before DDB', () => {
    it.each(['put', 'create', 'upsert', 'update', 'patch', 'delete', 'remove'])(
      '"%s" throws with [electrodb-migrations] prefix before any DDB call',
      (method) => {
        const facade = createReadOnlyFacade(makeStubEntity('User'), makeStubDocClient(), 'test-table');
        expect(() => (facade as any)[method]()).toThrow('[electrodb-migrations]');
      }
    );
  });
  describe('CTX-02: read methods are accessible', () => {
    it('exposes get, query, scan, find, match, parse', () => { ... });
  });
});
```

**Spike test requirement** (RESEARCH Assumption A4): This file must include a test or a separate `spike.test.ts` that verifies `new Entity(entity.schema, { client, table })` produces a functional clone. The test must call `.params()` on a method call (not `.go()` — no real DDB needed) and assert the correct params shape. This is a Wave 0 BLOCKER.

---

### `tests/unit/ctx/_helpers.ts` (test utility)

**Analog:** `tests/unit/rollback/_stub-service.ts`

**Why:** Same role — provides reusable stub factories shared across multiple unit test files in the same directory.

**Structure pattern** (from `tests/unit/rollback/_stub-service.ts` lines 1–30):
```typescript
/**
 * Shared helpers for Phase 6 ctx unit tests.
 *
 * Provides:
 *   - `makeStubEntity(entityName)` — minimal ElectroDB-shaped stub (schema property,
 *     model.entity, get/query/scan/put stubs)
 *   - `makeStubDocClient()` — minimal DDB document client stub
 *   - `makeStubMigration(opts)` — Migration-shaped stub with configurable reads,
 *     entityName, and up/down functions
 *   - `writeTestSnapshot(dir, entityName, fingerprint)` — writes a minimal
 *     `.snapshot.json` file to `dir` so `readEntitySnapshot` succeeds in tests
 *     that need the fingerprint validation path
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
```

**Key helpers needed:**
1. `makeStubEntity(entityName)` — returns a minimal object with `model.entity`, `schema`, and stub `.get/.query/.scan/.put` methods.
2. `makeStubDocClient()` — returns `{ send: vi.fn() }` (the send spy is used for batchGet stubs).
3. `makeStubMigration({ entityName, reads, hasDown })` — returns a minimal `Migration`-shaped object.
4. `writeTestSnapshot(dir, entityName, fingerprint)` — writes a minimal JSON snapshot file so `readEntitySnapshot` can be called in tests that exercise the fingerprint validation path. Uses `node:fs` `writeFileSync`. This avoids needing a real `.electrodb-migrations/` directory in unit tests.

---

### `tests/unit/rollback/preconditions-ctx08.test.ts` (unit test)

**Analog:** `tests/unit/rollback/preconditions.test.ts` (exact match — new file in the same directory)

**Why:** Extends the existing preconditions test suite with CTX-08 cases. Same structure, same `makeRollbackStubService()` usage, same `makeRow()` helper pattern.

**Structure pattern:**
```typescript
/**
 * Unit tests for `checkPreconditions` CTX-08 extension.
 *
 * Tests the new Step 10: CTX-08 refusal when a reads-target entity has a
 * later-applied migration that blocks rollback.
 *
 * Import the existing makeRow / makeLockRow helpers from preconditions.test.ts
 * or duplicate them here (prefer duplication to avoid cross-test-file imports).
 */
import { describe, expect, it } from 'vitest';
import { makeRollbackStubService } from './_stub-service.js';
import { checkPreconditions } from '../../../src/rollback/preconditions.js';

describe('checkPreconditions CTX-08', () => {
  it('refuses with READS_DEPENDENCY_APPLIED when a reads-target has a later-applied migration', async () => {
    const stub = makeRollbackStubService();
    // Inject rows: target M reads 'Team'; a Team migration was applied after M
    stub.setScanPages(undefined, [
      makeRow({ id: 'M-user', entityName: 'User', status: 'applied', toVersion: '2', reads: new Set(['Team']) }),
      makeRow({ id: 'M-team', entityName: 'Team', status: 'applied', fromVersion: '2', toVersion: '3' }),
    ]);
    // ...
    expect(result.kind).toBe('refuse');
    expect((result.error as any).details?.reason).toBe('READS_DEPENDENCY_APPLIED');
  });

  it('proceeds when reads-target has no later-applied migration', async () => { ... });
  it('proceeds when targetRow.reads is empty', async () => { ... });
});
```

**Key stub extension:** `makeRow` must accept an optional `reads?: Set<string>` field to populate `targetRow.reads`. Add a Phase-6 overload to the local `makeRow` helper (or pass it through `overrides`).

---

### `tests/integration/ctx/ctx-read.test.ts` (integration test)

**Analog:** `tests/integration/rollback/std-classify.test.ts` and `tests/integration/runner/apply-happy-path-1k.test.ts`

**Why:** Cross-entity read tests require a real DDB table with both User and Team records, a real unguarded client, and a real snapshot file on disk. This is exactly the same setup complexity as the STD integration test (two entity types in one table).

**Structure pattern** (from `tests/integration/rollback/_helpers.ts` lines 1–50):
```typescript
/**
 * Integration tests for ctx.entity() cross-entity reads (CTX-02, SC-1, SC-2, SC-5).
 *
 * Covers the four declared/undeclared × in-bounds/out-of-bounds combinations:
 *   1. declared + in-bounds: reads:[Team], snapshot matches → succeeds
 *   2. declared + out-of-bounds: reads:[Team], snapshot mismatch → EDBStaleEntityReadError
 *   3. undeclared + in-bounds: no reads, snapshot matches → lazy validation passes
 *   4. undeclared + out-of-bounds: no reads, snapshot mismatch → EDBStaleEntityReadError
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
// ...

let setup: CtxTestTableSetup;
beforeAll(async () => {
  setup = await setupCtxTestTable({ fixture: 'User-reads-Team' });
}, 30_000);
afterAll(async () => {
  await setup.cleanup();
});
```

**Setup helper pattern:** A `setupCtxTestTable` helper in `tests/integration/ctx/_helpers.ts` mirrors `setupRollbackTestTable`. It must:
1. Create the table, bootstrap migration state.
2. Seed Team records (so `ctx.entity(Team).get(...)` has something to return).
3. Write a snapshot file to a temp dir for the Team entity (for fingerprint validation).
4. Return the setup bundle with the snapshot dir path.

**Critical integration test invariant (SC-1):** `ctx.entity(Team).get(...).go()` must succeed WHILE the lock is held in `apply` state. The guard middleware is on the user's guarded client, NOT on the runner's unguarded `docClient`. So the read through the facade should bypass the guard — this is the key assertion. Verify by checking the test does NOT use a guarded client for the Team entity read.

**Pitfall from RESEARCH Pitfall 5:** Integration tests must write the snapshot file before calling `buildCtx`. The test setup writes a `Team.snapshot.json` to a temporary directory and passes that directory as `cwd` to `buildCtx` (or to `applyFlowScanWrite` via `args.cwd`).

---

### `tests/integration/ctx/ctx-audit-row.test.ts` (integration test)

**Analog:** `tests/integration/rollback/audit-row-shape.test.ts`

**Why:** Verifies that after `applyFlow` runs on a migration with `reads: [Team]`, the `_migrations` DDB row has `reads` set to `{'Team'}`. Same "audit row shape" pattern as Phase 5's equivalent.

**Structure pattern:**
```typescript
/**
 * Integration test: reads persisted on _migrations row (CTX-06, SC-4).
 *
 * After apply, the _migrations row must have reads = Set(['Team']).
 * Re-loading the row from the audit log surfaces the same set.
 */
describe('CTX-06: reads persisted on _migrations row', () => {
  it('_migrations.reads is a Set containing "Team" after apply', async () => {
    const row = await setup.service.migrations.get({ id: migration.id }).go();
    expect(row.data?.reads).toEqual(new Set(['Team']));
  });
});
```

---

### `tests/integration/rollback/ctx08-refusal.test.ts` (integration test)

**Analog:** `tests/integration/rollback/lock-cycle.test.ts`

**Why:** CTX-08 tests rollback refusal — the same structural pattern as lock-cycle tests (set up a specific table state, call `rollback`, assert refusal error shape and code).

**Structure pattern:**
```typescript
/**
 * Integration test: CTX-08 rollback refusal.
 *
 * If migration M (User v1→v2) declared reads: [Team], and a Team migration
 * has been applied after M, then rollback of M must refuse with
 * EDBRollbackNotPossibleError({ reason: 'READS_DEPENDENCY_APPLIED' }).
 */
describe('CTX-08: rollback refused when reads-target has later applied migration', () => {
  it('refuses with READS_DEPENDENCY_APPLIED', async () => {
    await expect(rollback({ ..., migration: userMigration })).rejects.toThrow(EDBRollbackNotPossibleError);
    await expect(rollback({ ..., migration: userMigration })).rejects.toMatchObject({
      details: { reason: 'READS_DEPENDENCY_APPLIED' },
    });
  });
});
```

---

### `tests/_helpers/sample-migrations/User-reads-Team/` (fixture migration)

**Analog:** `tests/_helpers/sample-migrations/User-and-Team-std/` (exact match)

**Why:** The STD fixture is the closest existing fixture — it defines both User AND Team entities in a single fixture directory, both sharing a table. The `User-reads-Team` fixture extends this pattern by declaring `reads: [Team]` in the migration.

**File structure:**
```
tests/_helpers/sample-migrations/User-reads-Team/
├── index.ts           # barrel — named exports only
├── v1.ts              # frozen UserV1 entity factory (same as User-and-Team-std/v1.ts pattern)
├── v2.ts              # frozen UserV2 entity factory
├── team.ts            # Team entity factory (bound to same table)
├── migration.ts       # defineMigration with reads: [createTeamEntity(client, table)]
└── README.md          # (optional, but User-and-Team-std has one)
```

**`migration.ts` pattern** (from `User-and-Team-std/migration.ts`):
```typescript
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defineMigration } from '../../../../src/migrations/index.js';
import { createUserV1ReadsTeam } from './v1.js';
import { createUserV2ReadsTeam } from './v2.js';
import { createTeamEntityReadsTeam } from './team.js';

export const createUserReadsTeamMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000005-User-reads-Team',
    entityName: 'User',
    from: createUserV1ReadsTeam(client, table),
    to: createUserV2ReadsTeam(client, table),
    reads: [createTeamEntityReadsTeam(client, table)],
    up: async (record, ctx) => {
      // Use ctx.entity(Team) to fetch the related Team record
      const team = ctx ? await (ctx.entity(createTeamEntityReadsTeam(client, table) as any)).get({ id: (record as any).teamId }).go() : null;
      return { ...(record as Record<string, unknown>), teamName: team?.data?.name ?? 'unknown', status: 'active' };
    },
  });
```

**`team.ts` pattern** (from `User-and-Team-std/index.ts` — Team entity factory exists there):
```typescript
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';

export const createTeamEntityReadsTeam = (client: DynamoDBDocumentClient, table: string) =>
  new Entity(
    {
      model: { entity: 'Team', version: '1', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client, table },
  );
```

**Convention:** Fixture factories are named with a suffix that identifies the fixture directory (e.g. `createUserV1ReadsTeam` not `createUserV1`). This avoids name collisions when multiple fixtures are imported in the same test file.

---

### `tests/_helpers/sample-migrations/User-self-read/` (fixture migration, CTX-04 trigger)

**Analog:** `tests/_helpers/sample-migrations/User-add-status/` (exact match — minimal migration with a synthetic self-read in `up()`)

**Why:** Simplest fixture — just a User migration whose `up()` calls `ctx.entity(User)` to trigger CTX-04 `EDBSelfReadInMigrationError`.

**File structure:**
```
tests/_helpers/sample-migrations/User-self-read/
├── index.ts
├── v1.ts
├── v2.ts
└── migration.ts
```

**`migration.ts`:**
```typescript
export const createUserSelfReadMigration = (client: DynamoDBDocumentClient, table: string) =>
  defineMigration({
    id: '20260601000006-User-self-read',
    entityName: 'User',
    from: createUserV1SelfRead(client, table),
    to: createUserV2SelfRead(client, table),
    // No reads declared — self-read is via ctx.entity at runtime
    up: async (record, ctx) => {
      if (ctx) {
        // This should throw EDBSelfReadInMigrationError
        await (ctx.entity(createUserV1SelfRead(client, table) as any)).get({ id: (record as any).id }).go();
      }
      return { ...(record as Record<string, unknown>), status: 'active' };
    },
  });
```

---

## Shared Patterns

### `.js` Extension on Relative Imports
**Source:** Every file in `src/` and `tests/`
**Apply to:** All new files in `src/ctx/` and all test files
**Convention:** All relative imports use `.js` extension, even when the source file is `.ts`:
```typescript
import { buildCtx } from '../ctx/build-ctx.js';
import { createReadOnlyFacade } from './read-only-facade.js';
```
Never use `.ts` extension in import paths. This is ESM convention enforced by the project.

---

### Named-Export Barrels (Never `export *`)
**Source:** `src/migrations/index.ts`, `src/lock/index.ts`, `src/snapshot/index.ts`
**Apply to:** `src/ctx/index.ts`, all `tests/_helpers/sample-migrations/*/index.ts`
**Convention:**
```typescript
// Pattern: name every symbol explicitly; never `export *`.
export { buildCtx } from './build-ctx.js';
export { createReadOnlyFacade } from './read-only-facade.js';
export type { MigrationCtx, ReadOnlyEntityFacade } from './types.js';
```

---

### Error Construction Pattern
**Source:** `src/rollback/preconditions.ts` lines 114–120
**Apply to:** `buildCtx`, preconditions CTX-08 check
**Convention:**
```typescript
const err = new EDBRollbackNotPossibleError(
  `Human-readable message with ${migrationId} interpolated.`,
  { reason: ROLLBACK_REASON_CODES.READS_DEPENDENCY_APPLIED, ...extraDetails },
);
(err as Error & { remediation?: string }).remediation = `Run \`...\` to fix this.`;
return { kind: 'refuse', error: err };
```
The `remediation` field is cast via type intersection (not typed on the class) — match this pattern exactly.

---

### `entity.model.entity` Access Pattern
**Source:** `src/runner/apply-flow.ts` line 132
**Apply to:** `buildCtx`, `read-only-facade.ts`, preconditions CTX-08
**Convention:**
```typescript
const entityName = (entity as unknown as { model: { entity: string } }).model.entity;
```
Always use `as unknown as { model: ... }` (double cast). The `as unknown` intermediate cast is the project convention for unsafe narrowing — do not use a single `as { model: ... }`.

---

### `biome-ignore` Comment for `any` on ElectroDB Types
**Source:** `src/migrations/types.ts` lines 15–16
**Apply to:** `src/ctx/read-only-facade.ts`, `src/ctx/build-ctx.ts`
**Convention:**
```typescript
// biome-ignore lint/suspicious/noExplicitAny: Required to reference ElectroDB's generic Entity<A, F, C, S, P> without forcing schema generics through the public Migration surface.
```
The comment must include the rationale. Use on the same line as the `any` usage or on the line immediately above.

---

### `// eslint-disable-next-line no-console -- diagnostic only` Pattern
**Source:** `src/runner/apply-flow.ts` lines 62, 79
**Apply to:** Any `console.error` in `buildCtx` or strategy executors
**Convention:** CLI output uses `picocolors` + the `log()` helper. Internal diagnostic errors that must reach stderr regardless of log level use `console.error` with the `eslint-disable-next-line` inline comment. The `-- diagnostic only` suffix is load-bearing for code review.

---

### Integration Test Setup: `beforeAll` + `afterAll` + `cleanup`
**Source:** `tests/integration/rollback/_helpers.ts` lines 166–277
**Apply to:** All new integration test files
**Convention:**
```typescript
let setup: CtxTestTableSetup;
beforeAll(async () => {
  setup = await setupCtxTestTable({ fixture: 'User-reads-Team' });
}, 30_000);   // 30s timeout for table provisioning
afterAll(async () => {
  await setup.cleanup();
});
```
The `30_000` timeout is a project-wide convention for `beforeAll` in integration tests. Never use `60_000` or lower values like `10_000`.

---

### `DdbLocalReachable` Skip Guard
**Source:** All integration test files in `tests/integration/`
**Apply to:** All new integration tests
**Convention:**
```typescript
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';

beforeAll(async () => {
  if (!(await isDdbLocalReachable())) {
    console.log(skipMessage);
    return;
  }
  setup = await setupCtxTestTable(...);
});
```
Without this guard, integration tests will hard-fail when DDB Local is not running instead of skipping gracefully.

---

### Source-Scan Invariants (Convention Guards)

**Source:** `tests/unit/lock/source-scan.test.ts`

The existing source-scan test glob is:
```
SCAN_GLOB = 'src/{lock,guard,runner,rollback}/**/*.ts'
```

**Phase 6 decision on `src/ctx/`:**

The source-scan invariants check three things:
1. Every `migrationState.get(` call uses `consistent: CONSISTENT_READ`.
2. No `setInterval(` anywhere.
3. No inline `consistent: true`.

`src/ctx/` contains `buildCtx`, `read-only-facade`, and `types`. None of these files call `migrationState.get(` — `buildCtx` calls `readEntitySnapshot` (filesystem) and `fingerprintEntityModel` (computation). None use `setInterval`. None use `consistent: true`.

**Decision: do NOT add `src/ctx/` to the source-scan glob.** The invariants the source-scan enforces are specific to lock-row reads and heartbeat scheduling. `src/ctx/` has no lock-row reads and no scheduling. Adding it would expand the glob without providing any additional safety guarantee relevant to `src/ctx/`.

However, the planner MUST add a separate source-scan assertion: `src/ctx/` must NOT contain any call to `entity.setClient(` (Pitfall 1). This is a new invariant specific to Phase 6:
```typescript
it('no entity.setClient( in src/ctx/ — use new Entity(schema, {client}) instead (Pitfall 1)', async () => {
  const matches = await scanFiles('src/ctx/**/*.ts', (line) => /\.setClient\(/.test(line), { stripComments: true });
  expect(matches).toEqual([]);
});
```
This test belongs in `tests/unit/ctx/read-only-facade.test.ts` or a new `tests/unit/ctx/source-scan.test.ts`.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| Wave 0 spike test (`tests/unit/ctx/entity-clone.spike.test.ts`) | spike/validation | transform | No existing analog for "verify `new Entity(schema, config)` clone works" — this is a new assumption (A4 in RESEARCH). Must be written before any other Wave 1 work. |

**Spike test description:** Constructs a real ElectroDB Entity from a known schema, clones it with `new Entity(entity.schema, { client: stubClient, table: 'test' })`, and calls `.get({id: 'x'}).params()` on the clone. Asserts:
1. The clone's `.params()` returns a valid DDB `GetItem` params shape with the correct `TableName`.
2. The clone's `.query` namespace is accessible (not `undefined`).
3. The original entity's client reference is NOT changed (setClient mutation check).

If this test fails, the entire `createReadOnlyFacade` implementation strategy must change — this is a Wave 0 BLOCKER before any other Phase 6 work proceeds.

---

## Metadata

**Analog search scope:** `src/runner/`, `src/rollback/`, `src/migrations/`, `src/errors/`, `src/snapshot/`, `src/guard/`, `tests/unit/rollback/`, `tests/integration/rollback/`, `tests/_helpers/sample-migrations/`
**Files scanned:** 28 source files, 12 test files
**Pattern extraction date:** 2026-05-09
