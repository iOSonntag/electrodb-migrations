/**
 * `src/scaffold/` barrel — pure scaffold utilities consumed by Plan 07's
 * `create` command orchestrator.
 *
 * IMPORTANT: This barrel intentionally re-exports ONLY the three pure-function
 * primitives below. Plan 04's `bump-entity-version.ts` (ts-morph-based source
 * editor) is NOT re-exported here — bundling ts-morph through this barrel
 * would pull it into `src/index.ts`'s transitive import graph and violate
 * the FND-06 "no ts-morph in the library bundle" invariant
 * (see tests/unit/build/no-tsmorph-in-library.test.ts).
 */
export { renderFrozenEntitySource } from './frozen-snapshot.js';
export type { RenderFrozenEntitySourceArgs } from './frozen-snapshot.js';
// computeIntegrityHash + createMigrationId/sanitizeSlug/formatTimestamp
// are added in Task 2 of this plan.
