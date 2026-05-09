/**
 * Barrel for the User-and-Team-std sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 5 RBK-11 STD safety integration tests
 * import from this barrel.
 *
 * This fixture co-locates User (v1 + v2) and Team entities in the SAME table
 * to prove that rolling back the User migration does NOT touch Team records.
 * See migration.ts JSDoc for full rationale.
 */

export { createUserV1Std } from './v1.js';
export { createUserV2Std } from './v2.js';
export { createTeamEntity } from './team.js';
export { createUserAddStatusStdMigration } from './migration.js';
