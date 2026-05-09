/**
 * `createReadOnlyFacade(entity, client, tableName)` — Phase 6 read-only wrapper
 * over an ElectroDB Entity. Bound to the runner's unguarded DynamoDBDocumentClient.
 *
 * **Strategy (RESEARCH §OQ1, verified by Plan 06-01 spike test):**
 * Construct a fresh `new Entity(entity.schema, { client, table })`. This produces
 * a functional clone bound to the new client WITHOUT mutating the original
 * entity's client reference (Pitfall 1). The clone exposes the full read API
 * (get/query/scan/find/match/parse) via direct property reference; write methods
 * are intercepted at the property level by `makeWriteThrow` and throw a plain
 * `Error` with the `[electrodb-migrations]` prefix before any DDB contact (CTX-03).
 *
 * **Why direct property access for `query` and `scan` (Pitfall 2):**
 * `entity.query` and `entity.scan` are namespace objects in ElectroDB (e.g.,
 * `entity.query.byId(...)`). Calling `.bind(boundEntity)` on a namespace object
 * produces a bound function wrapping the object, NOT a bound namespace —
 * `boundEntity.query.byId(...)` would throw `TypeError: not a function`. Always
 * reference these as direct properties: `query: boundEntity.query` (NOT `.bind(boundEntity)`).
 *
 * **Why `get`/`find`/`match`/`parse` are bound:**
 * These ARE callable methods on the Entity class — they reference `this`
 * internally for chain construction. Binding to `boundEntity` ensures `this` is
 * the cloned entity (with its unguarded client + new table) rather than the
 * facade object.
 */
import { Entity } from 'electrodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AnyElectroEntity } from '../migrations/types.js';

/** Module-private — the consistent hint appended to every write-trap throw. */
const READ_ONLY_HINT =
  'ctx is read-only. Writes through ctx are not permitted. ' +
  'Return the transformed record from up() instead.';

/**
 * Builds a write-trap function for a single write method (e.g., `put`,
 * `delete`). The returned function throws a plain `Error` (NOT an `EDB*`
 * error class — this is a programming error surfaced to the migration author,
 * not a runtime DDB error per RESEARCH "Anti-Patterns" line 529).
 *
 * The error message includes the method name so the stack trace points at
 * the exact misuse, and the `[electrodb-migrations]` prefix matches the
 * convention used in `src/runner/apply-flow.ts:62,79` for diagnostic stderr
 * output.
 */
function makeWriteThrow(method: string): () => never {
  return (): never => {
    throw new Error(`[electrodb-migrations] ctx.entity().${method}() — ${READ_ONLY_HINT}`);
  };
}

/**
 * Construct a read-only facade over `entity`, bound to `client` + `tableName`.
 *
 * @param entity     - The user-imported ElectroDB Entity to wrap.
 * @param client     - The runner's unguarded DynamoDBDocumentClient.
 * @param tableName  - The DynamoDB table name (typically the user's table).
 * @returns A facade exposing only the 6 read methods + 7 write traps.
 */
export function createReadOnlyFacade(
  entity: AnyElectroEntity,
  client: DynamoDBDocumentClient,
  tableName: string,
) {
  // Clone the entity bound to the unguarded client. `new Entity(schema, config)`
  // is non-mutating per the Wave 0 spike test (Plan 06-01).
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB's Entity has a 5-param generic; cloning across the boundary requires an `any` cast for the schema property.
  const boundEntity = new Entity((entity as any).schema, { client, table: tableName }) as AnyElectroEntity;

  return {
    // Read methods — bound to the cloned entity.
    get: boundEntity.get.bind(boundEntity),
    // `query` and `scan` are namespace objects (Pitfall 2): direct property reference, never `.bind`.
    query: boundEntity.query,
    scan: boundEntity.scan,
    find: boundEntity.find.bind(boundEntity),
    match: boundEntity.match.bind(boundEntity),
    parse: boundEntity.parse.bind(boundEntity),
    // Write traps (CTX-03) — throw before any DDB call.
    put: makeWriteThrow('put'),
    create: makeWriteThrow('create'),
    upsert: makeWriteThrow('upsert'),
    update: makeWriteThrow('update'),
    patch: makeWriteThrow('patch'),
    delete: makeWriteThrow('delete'),
    remove: makeWriteThrow('remove'),
  };
}

/**
 * Runtime type of the facade returned by `createReadOnlyFacade`. Distinct
 * from the public `ReadOnlyEntityFacade<E>` type in `src/ctx/types.ts` —
 * the runtime version is the inferred-shape; the public version is the
 * generic that callers consume. Plan 06-03's `buildCtx` casts between the
 * two at the `MigrationCtx` boundary.
 */
export type ReadOnlyFacadeRuntime = ReturnType<typeof createReadOnlyFacade>;
