/**
 * Barrel for the User-add-status-no-down sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 5 refusal tests import from this barrel.
 *
 * This fixture intentionally OMITS `down()` and `rollbackResolver`. It is the
 * canonical fixture for testing `EDBRollbackNotPossibleError({reason: 'NO_DOWN_FUNCTION'})`
 * (RBK-09) and `NO_RESOLVER` (RBK-10) refusal cases.
 * See migration.ts JSDoc for full rationale.
 */

export { createUserV1 } from './v1.js';
export { createUserV2 } from './v2.js';
export { createUserAddStatusNoDownMigration } from './migration.js';
