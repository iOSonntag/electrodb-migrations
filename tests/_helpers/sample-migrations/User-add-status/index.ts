/**
 * Barrel for the User-add-status sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 4 runner tests import from this barrel.
 */

export { createUserV1 } from './v1.js';
export { createUserV2 } from './v2.js';
export { createUserAddStatusMigration } from './migration.js';
