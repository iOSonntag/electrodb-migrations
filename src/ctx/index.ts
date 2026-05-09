/**
 * Phase 6 cross-entity reads — public barrel.
 *
 * Pattern: name every symbol explicitly; never `export *` (matches the
 * convention in `src/migrations/index.ts`, `src/snapshot/index.ts`).
 */
export { buildCtx } from './build-ctx.js';
export { createReadOnlyFacade } from './read-only-facade.js';
export type { MigrationCtx, ReadOnlyEntityFacade } from './types.js';
