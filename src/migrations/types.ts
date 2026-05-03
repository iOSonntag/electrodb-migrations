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
  /** Custom rollback resolver (Phase 5 / RBK-08). */
  rollbackResolver?: (...args: unknown[]) => unknown;
}
