/**
 * Barrel for the User-add-status-with-resolver sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 5 rollback custom-strategy tests
 * import from this barrel.
 *
 * This fixture includes both a `down()` function and a `rollbackResolver` and
 * is the canonical fixture for `custom` rollback strategy tests (README §2.2.4).
 * See migration.ts JSDoc for full rationale.
 */

export { createUserV1 } from './v1.js';
export { createUserV2 } from './v2.js';
export { createUserAddStatusWithResolverMigration } from './migration.js';
