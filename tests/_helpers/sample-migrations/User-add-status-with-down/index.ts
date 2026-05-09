/**
 * Barrel for the User-add-status-with-down sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 5 rollback strategy tests import
 * from this barrel.
 *
 * This fixture includes a `down()` function and is the canonical "happy path"
 * for `projected`, `fill-only`, and `custom` rollback strategy tests.
 * See migration.ts JSDoc for full rationale.
 */

export { createUserV1 } from './v1.js';
export { createUserV2 } from './v2.js';
export { createUserAddStatusWithDownMigration } from './migration.js';
