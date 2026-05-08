import { createJiti } from 'jiti';
import { EDBMigrationError } from '../errors/base.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Wraps any
 * error thrown by jiti during migration-file evaluation. Pitfall #9 mirror
 * — without this wrapper, an inner SDK error from the user's migration
 * imports would bubble unwrapped and confuse the operator.
 *
 * `code` is stable across framework versions so caller code can duck-type
 * check it: `err.code === 'EDB_MIGRATION_LOAD_ERROR'`.
 */
export class EDBMigrationLoadError extends EDBMigrationError {
  readonly code = 'EDB_MIGRATION_LOAD_ERROR' as const;
}

/**
 * Load a user-authored `migration.ts` file via jiti. Mirrors
 * `src/config/load.ts:loadConfigFile` (FND-06 lazy-chain wiring — jiti is
 * pulled in only when the runner is actually loading user code).
 *
 * Returns the default export if present, falling back to the module namespace.
 * Wraps inner errors in {@link EDBMigrationLoadError} with `details.path`
 * and `details.cause`.
 *
 * The frozen `v1.ts` and `v2.ts` are imported BY `migration.ts`, so a
 * single jiti call transitively loads them.
 *
 * **RUN-06 / RUN-07 note:** this loader is intentionally side-effect-free;
 * the caller (`loadPendingMigrations`) performs the sequence-sort and
 * _migrations-row correlation after loading all on-disk migrations.
 */
export async function loadMigrationFile(
  path: string,
): Promise<Migration<AnyElectroEntity, AnyElectroEntity>> {
  try {
    const jiti = createJiti(import.meta.url, { tryNative: true });
    const mod = (await jiti.import(path)) as { default?: unknown };
    return (mod.default ?? mod) as Migration<AnyElectroEntity, AnyElectroEntity>;
  } catch (err) {
    throw new EDBMigrationLoadError(
      `Failed to load migration file: ${path}\n${err instanceof Error ? err.message : String(err)}`,
      { path, cause: err },
    );
  }
}
