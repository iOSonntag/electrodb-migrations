/**
 * Public type definitions for the Phase 6 cross-entity reads `ctx` argument.
 *
 * Consumed by:
 *   - User-authored `up()`/`down()` functions (CTX-01)
 *   - The runner's `buildCtx` factory (Plan 06-03 / `src/ctx/build-ctx.ts`)
 *   - Plan 06-04's rollback strategy executors (which thread `ctx` to `down()`)
 *   - Phase 8's test harness (will accept an optional `ctx?: MigrationCtx` injection)
 *
 * Shape source: RESEARCH §Code Examples lines 627-657, PATTERNS lines 60-84.
 *
 * **Why write methods are typed as `() => never`:**
 * Typing them as `never` (non-callable) gives "property does not exist" errors
 * in some IDE setups; typing them as `() => never` (callable but return never)
 * gives a clearer error at the call site (the function body's `never` return
 * surfaces as "type 'never' is not assignable to type ...").
 *
 * **Why this file lives at `src/ctx/types.ts` rather than `src/migrations/types.ts`:**
 * `Migration<From, To>` keeps `ctx?: unknown` at the Migration interface level
 * (existing field, no Phase 6 change). Tightening to `MigrationCtx` is deferred
 * to Plan 06-03 / Plan 06-06 which decides how to bridge without creating a
 * `src/migrations/types.ts` ↔ `src/ctx/types.ts` cycle (PATTERNS lines 369-371
 * documents the trade-off).
 */
import type { AnyElectroEntity } from '../migrations/types.js';

/**
 * Read-only facade over an ElectroDB Entity. Returned by `MigrationCtx.entity(Other)`
 * — bound to the runner's unguarded client so the read bypasses the guard.
 *
 * **Read methods (CTX-02):** `get`, `query`, `scan`, `find`, `match`, `parse`.
 * Their type is the corresponding member type from the entity itself, so callers
 * get full ElectroDB-typed return shapes (record types, query namespace shapes, etc.).
 *
 * **Write methods (CTX-03):** typed as `() => never` so the TypeScript compiler
 * refuses `facade.put({...})` at the call site. The runtime implementation also
 * throws at the call point (RESEARCH §Pattern 2). Defense in depth.
 *
 * **`batchGet` is intentionally omitted** from the type — its ElectroDB return
 * shape varies across versions and tightening would block on Phase 8 inference
 * work (PATTERNS line 87). The runtime implementation MAY include `batchGet` as
 * an `any`-typed pass-through (see Plan 06-02 Task 2 for the implementation
 * decision — leave the type out for v0.1).
 */
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

/**
 * The `ctx` argument passed as the second parameter to `up()` and `down()`
 * (CTX-01). Constructed by `buildCtx(...)` in `src/ctx/build-ctx.ts` (Plan 06-03).
 *
 * `ctx.entity(Other)` returns a `ReadOnlyEntityFacade<Other>` bound to the
 * runner's unguarded DynamoDBDocumentClient. The facade enforces:
 *   - CTX-03: writes throw before any DDB call
 *   - CTX-04: self-reads (when `Other` is the migration's own entity) throw
 *     `EDBSelfReadInMigrationError` before any DDB call
 *   - CTX-05: stale-fingerprint reads throw `EDBStaleEntityReadError` before
 *     any DDB call (eager pre-flight for declared `reads`; lazy at first call
 *     for undeclared targets)
 */
export interface MigrationCtx {
  entity<E extends AnyElectroEntity>(other: E): ReadOnlyEntityFacade<E>;
}
