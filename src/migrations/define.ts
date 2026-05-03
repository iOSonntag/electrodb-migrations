import type { AnyElectroEntity, Migration } from './types.js';

/**
 * Identity factory for `migration.ts` files. Provides autocomplete +
 * type-checking for the user's transform definition. Resolution
 * (validation, registration with the runner) happens in Phase 4's runner.
 *
 * @example
 *   // src/database/migrations/<timestamp>-User-add-status/migration.ts
 *   import { defineMigration } from 'electrodb-migrations';
 *   import { User as UserV1 } from './v1.js';
 *   import { User as UserV2 } from './v2.js';
 *
 *   export default defineMigration({
 *     id: '20260501083000-User-add-status',
 *     entityName: 'User',
 *     from: UserV1,
 *     to: UserV2,
 *     up: async (record) => ({ ...record, status: 'active' }),
 *   });
 */
export function defineMigration<From extends AnyElectroEntity, To extends AnyElectroEntity>(input: Migration<From, To>): Migration<From, To> {
  return input;
}
