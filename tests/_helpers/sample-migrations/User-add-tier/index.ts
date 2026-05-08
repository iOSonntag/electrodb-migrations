/**
 * Barrel for the User-add-tier sample migration fixture.
 *
 * Named exports only — never `export *` — so the fixture surface stays
 * auditable and tree-shakeable.
 *
 * Note: `createUserV2` here is User v2 (the "from" entity for this migration),
 * which is the same entity as User-add-status's v2. It is aliased as `createUserV2`
 * within this fixture's scope to match the migration's "from" side.
 */

export { createUserV2 } from './v1.js';
export { createUserV3 } from './v2.js';
export { createUserAddTierMigration } from './migration.js';
