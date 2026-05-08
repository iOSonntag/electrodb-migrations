/**
 * Public programmatic API barrel.
 *
 * Only `createMigrationsClient` and its type surface are exposed here.
 * The implementation details (runner orchestrators, internal-entity bundle,
 * guard wiring) remain behind this facade.
 *
 * Created by Plan 04-11 (createMigrationsClient programmatic API).
 */
export { createMigrationsClient } from './create-migrations-client.js';
export type { CreateMigrationsClientArgs, MigrationsClient } from './types.js';
