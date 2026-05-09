/**
 * Barrel for the User-self-read sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 6 CTX-04 unit and integration tests
 * import from this barrel.
 *
 * This fixture declares NO `reads` on its migration. The up() calls
 * ctx.entity(<self>) at runtime to trigger CTX-04 EDBSelfReadInMigrationError.
 */

export { createUserV1SelfRead } from './v1.js';
export { createUserV2SelfRead } from './v2.js';
export { createUserSelfReadMigration } from './migration.js';
