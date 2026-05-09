import type { Entity } from 'electrodb';

/**
 * Wide ElectroDB Entity reference at the type-system boundary. ElectroDB's
 * `Entity<A, F, C, S, P>` requires four to five type parameters; users supply
 * concrete schema-derived ones at the call site (e.g. when their compiled
 * frozen `v1.ts` re-exports a parameterized `Entity<...>`). Consumers of the
 * `Migration` interface do not (and should not) carry that schema generic
 * load through the framework's runtime API surface — Phase 8 tightens inference
 * via `Item<E>` against the user's own schemas.
 *
 * Mirrors ElectroDB's own internal helper typings (`EntityItem<E extends
 * Entity<any, any, any, any>>` etc. in `electrodb/index.d.ts`).
 */
// biome-ignore lint/suspicious/noExplicitAny: Required to reference ElectroDB's generic Entity<A, F, C, S, P> without forcing schema generics through the public Migration surface.
export type AnyElectroEntity = Entity<any, any, any, any>;

/**
 * Arguments passed to a custom `rollbackResolver` function on each record.
 *
 * RBK-08 / README §2.2.4 / RESEARCH OQ7 disposition (additive widening from Phase 2
 * placeholder `(...args: unknown[]) => unknown`).
 *
 * **Field presence by type:**
 *
 * | Field        | Type A (v1+v2 coexist) | Type B (v2-only) | Type C (v1-only) |
 * |--------------|------------------------|------------------|------------------|
 * | `kind`       | `'A'`                  | `'B'`            | `'C'`            |
 * | `v1Original` | present                | absent           | present          |
 * | `v2`         | present                | present          | absent           |
 * | `down`       | present if defined     | present if defined | present if defined |
 *
 * - `v1Original`: The existing v1 record. Present for type A (v1 mirror still exists
 *   post-migration) and type C (v1 was never migrated — v1-only row).
 * - `v2`: The v2 record. Present for type A (migrated record) and type B (fresh v2
 *   record with no v1 counterpart). Absent for type C.
 * - `down`: The migration's own `down()` function, if defined. The resolver can call it
 *   to apply the projected inverse transform. Undefined if the migration has no `down`.
 *   Passing `down` here is intentionally minimal — the resolver has no client reference
 *   and cannot escape into unguarded DDB reads/writes (RESEARCH §Section 4 line 1216).
 */
export interface RollbackResolverArgs {
  /** Classifier result: A (v1+v2), B (v2-only), or C (v1-only). */
  kind: 'A' | 'B' | 'C';
  /**
   * Original v1 record. Present for type A and C.
   * Absent for type B (no v1 mirror exists for fresh v2 records).
   */
  v1Original?: Record<string, unknown>;
  /**
   * The v2 record. Present for type A and B.
   * Absent for type C (v1-only records were never migrated).
   */
  v2?: Record<string, unknown>;
  /**
   * The migration's `down()` inverse transform, if defined.
   * The resolver may call this to delegate (e.g., `return await down(v2)` for type B).
   * Undefined if the migration did not define a `down` function.
   */
  down?: (record: unknown, ctx?: unknown) => Promise<unknown>;
}

/**
 * The shape a user passes to `defineMigration`. Documented in README §4
 * (Quick start) and §6 (cross-entity reads). Phase 2 ships the runtime
 * factory; Phase 8 (test harness) tightens `up`/`down` parameter inference
 * via ElectroDB's `Item` machinery without breaking this surface (additive
 * widening is allowed; tightening is type-compatible).
 *
 * The `ctx` shape is intentionally `unknown` here — Phase 6 introduces the
 * cross-entity `ctx.entity(Other)` reader. The `rollbackResolver` shape is
 * also `unknown` — Phase 5 ships the four rollback strategies.
 */
export interface Migration<From extends AnyElectroEntity, To extends AnyElectroEntity> {
  /** Migration id, matching the migration folder name (`<timestamp>-<entity>-<slug>`). */
  id: string;
  /** Source-of-truth entity name; matches `model.entity` on `from` and `to`. */
  entityName: string;
  /** Frozen v1 entity (imported from `./v1.js`). */
  from: From;
  /** Frozen v2 entity (imported from `./v2.js`). */
  to: To;
  /** Forward transform. Receives a v1 record; returns a v2 record. */
  up: (record: unknown, ctx?: unknown) => Promise<unknown>;
  /** Optional inverse transform (required for post-finalize `projected` rollback). */
  down?: (record: unknown, ctx?: unknown) => Promise<unknown>;
  /** Cross-entity reads declared at scaffold time (Phase 6 / CTX-06). */
  reads?: ReadonlyArray<AnyElectroEntity>;
  /**
   * Custom rollback resolver (Phase 5 / RBK-08).
   *
   * Called once per record during `--strategy custom` rollback. The resolver
   * receives per-record context and decides what to PUT back (or delete).
   *
   * README §2.2.4 documents the canonical "delegate to down for type B, restore
   * v1Original for type A and C" pattern. RESEARCH OQ7 (lines 1636-1638) confirms
   * this is an additive widening from the Phase 2 opaque placeholder — existing
   * resolvers typed as `(args: unknown) => Promise<...>` continue to compile.
   *
   * **Return value semantics:**
   * - Return a v1-shaped record → PUT the record back to the v1 schema.
   * - Return `null` → delete the record (type A and C) or skip (type B, since v1 does not exist).
   * - Return `undefined` → treated as `null` (additive widening; same semantics).
   *
   * @see {@link RollbackResolverArgs} for the resolver argument shape.
   */
  rollbackResolver?: (args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>;
}
