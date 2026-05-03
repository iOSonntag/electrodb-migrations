import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { EDBMigrationError } from '../errors/base.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts` per A7. Wraps
 * any error thrown by jiti during config-file evaluation. Pitfall #9 — without
 * this wrapper, an inner SDK error (e.g. user's config imports `'sst'` which
 * needs AWS creds) would bubble unwrapped and confuse the operator.
 */
export class EDBConfigLoadError extends EDBMigrationError {
  readonly code = 'EDB_CONFIG_LOAD_ERROR' as const;
}

/**
 * The config file extensions the locator searches for, in priority order.
 * `.ts` first because the most common case is "TypeScript-first project".
 */
const CONFIG_NAMES = [
  'electrodb-migrations.config.ts',
  'electrodb-migrations.config.mts',
  'electrodb-migrations.config.cts',
  'electrodb-migrations.config.js',
  'electrodb-migrations.config.mjs',
  'electrodb-migrations.config.cjs',
  'electrodb-migrations.config.json',
] as const;

/**
 * Searches `cwd` for the first config file matching the priority list.
 * Returns the absolute path or `null` if none found. CFG-02.
 */
export function findConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of CONFIG_NAMES) {
    const path = join(cwd, name);
    if (existsSync(path)) return resolve(path);
  }
  return null;
}

/**
 * Loads a config file via jiti without compilation. Respects the user's
 * `tsconfig.json` path mappings (jiti reads them automatically). Returns the
 * resolved default export, falling back to the module namespace when no
 * default is exported.
 *
 * Pitfall #9 — wraps any inner error in `EDBConfigLoadError` so the operator
 * sees a framework-shaped error with the path and original cause attached.
 */
export async function loadConfigFile(path: string): Promise<unknown> {
  try {
    const jiti = createJiti(import.meta.url, { tryNative: true });
    const mod = (await jiti.import(path)) as { default?: unknown };
    return mod.default ?? mod;
  } catch (err) {
    throw new EDBConfigLoadError(
      `Failed to load config file: ${path}\n${err instanceof Error ? err.message : String(err)}`,
      { path, cause: err },
    );
  }
}
