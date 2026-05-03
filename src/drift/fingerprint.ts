/**
 * Tier-2 wrapper. The actual fingerprint logic lives in
 * `src/safety/fingerprint-projection.ts` (Tier 1) because it is one of the
 * four load-bearing safety primitives. Phase 2's drift classifier (kinds:
 * attribute-added, attribute-removed, etc.) consumes this re-export as the
 * shape-equality primitive and adds its own diff logic on top.
 */
export { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
export type { EntityProjection } from '../safety/fingerprint-projection.js';
