import type { MigrationsConfig } from './types.js';

/**
 * Identity factory for `electrodb-migrations.config.ts`. Provides
 * autocomplete + type-checking for the user's config file. Resolution
 * (defaults merge, invariants check) happens in `config/load.ts` (Plan 06).
 *
 * @example
 *   // electrodb-migrations.config.ts
 *   import { defineConfig } from 'electrodb-migrations';
 *   export default defineConfig({
 *     entities: 'src/entities',
 *     migrations: 'src/database/migrations',
 *     tableName: 'app_table',
 *   });
 */
export function defineConfig(input: MigrationsConfig): MigrationsConfig {
  return input;
}
