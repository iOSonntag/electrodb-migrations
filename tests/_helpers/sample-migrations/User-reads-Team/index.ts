/**
 * Barrel for the User-reads-Team sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable. Phase 6 CTX unit and integration tests
 * import from this barrel.
 *
 * This fixture co-locates User (v1 + v2) and Team entities in the SAME table
 * with `reads: [Team]` declared on the migration to test Phase 6 cross-entity
 * reads (CTX-01..06, CTX-08).
 */

export { createUserV1ReadsTeam } from './v1.js';
export { createUserV2ReadsTeam } from './v2.js';
export { createTeamEntityReadsTeam } from './team.js';
export { createUserReadsTeamMigration } from './migration.js';
