import { createJiti } from 'jiti';
import { EDBMigrationError } from '../errors/base.js';

/**
 * Internal error class — exported from `src/user-entities/index.ts` (the
 * barrel) so command catch-blocks can discriminate user-code load failures
 * from framework-internal errors. **MUST NOT** be re-exported from
 * `src/index.ts` (the public surface). Plan 01 added
 * `'EDBUserEntityLoadError'` to `FORBIDDEN_RUNTIME_KEYS` in
 * `tests/unit/build/public-surface.test.ts`; that test asserts absence from
 * `Object.keys(edbm)` so an accidental re-export from any future
 * `src/index.ts` edit is caught at unit-test time (FND-06).
 *
 * Mirrors `src/config/load.ts`'s `EDBConfigLoadError` pattern so the operator
 * sees a framework-shaped error with the offending source-file path attached
 * (Pitfall #9: an unwrapped jiti error from inside a user's `import 'sst'`
 * would bury the relevant context).
 */
export class EDBUserEntityLoadError extends EDBMigrationError {
  readonly code = 'EDB_USER_ENTITY_LOAD_ERROR' as const;
}

/**
 * Load a TypeScript entity file via jiti.
 *
 * **Pitfall 4 mitigation — per-call `createJiti`.** jiti caches transpiled
 * output keyed by absolute path; reusing a long-lived jiti instance across
 * consecutive `create` invocations leaves stale modules in the cache when
 * the user has edited the entity file between runs. RESEARCH §Pitfall 4
 * documents the failure mode (Windows FAT volumes with second-granularity
 * mtimes mask the staleness from jiti's invalidator). Constructing a fresh
 * jiti per call is a measured performance trade for correctness.
 *
 * Returns the loaded module namespace as `Record<string, unknown>` so the
 * caller (Plan 08's `inspect.ts`) can iterate exported keys without doing
 * its own type narrowing on `unknown`.
 */
export async function loadEntityFile(absolutePath: string): Promise<Record<string, unknown>> {
  try {
    const jiti = createJiti(import.meta.url, { tryNative: true });
    const mod = (await jiti.import(absolutePath)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    throw new EDBUserEntityLoadError(`Failed to load entity file: ${absolutePath}\n${err instanceof Error ? err.message : String(err)}`, {
      sourceFilePath: absolutePath,
      cause: err,
    });
  }
}
