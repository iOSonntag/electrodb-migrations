/**
 * `src/scaffold/` barrel — pure scaffold utilities consumed by Plan 07's
 * `create` command orchestrator.
 *
 * IMPORTANT: This barrel intentionally re-exports ONLY pure-function
 * primitives. Plan 04's source-editor module (which writes the user's
 * entity file via the AST manipulation library) is NOT re-exported here
 * — bundling that library through this barrel would pull it into
 * `src/index.ts`'s transitive import graph and violate the FND-06
 * "no source-editor in the library bundle" invariant (see the build-time
 * gate test under tests/unit/build/).
 */
export { renderFrozenEntitySource } from './frozen-snapshot.js';
export type { RenderFrozenEntitySourceArgs } from './frozen-snapshot.js';
export { computeIntegrityHash } from './integrity-hash.js';
export { createMigrationId, formatTimestamp, sanitizeSlug } from './migration-id.js';
export type { CreateMigrationIdArgs } from './migration-id.js';
export { renderMigrationTemplate } from './templates.js';
export type { RenderMigrationTemplateArgs } from './templates.js';
