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
 * **Pitfall 4 mitigation — per-call `createJiti` with caches disabled.**
 * jiti caches transpiled output in two places:
 *   - `fsCache` (filesystem cache under `node_modules/.cache/jiti`) keyed
 *     by absolute path + content hash
 *   - `moduleCache` (Node's `require.cache` integration) keyed by absolute
 *     path
 * Reusing a long-lived jiti instance across consecutive `create` /
 * `baseline` / `validate` invocations leaves stale modules in either cache
 * when the user has edited the entity file between runs. RESEARCH §Pitfall 4
 * documents the failure mode (Windows FAT volumes with second-granularity
 * mtimes mask the staleness from jiti's invalidator). The per-call
 * `createJiti` plus `fsCache: false` + `moduleCache: false` ensures every
 * call sees the file as it currently exists on disk — a measured
 * performance trade for correctness. Verified by the
 * "updates only the changed snapshot..." baseline test.
 *
 * Returns the loaded module namespace as `Record<string, unknown>` so the
 * caller (Plan 08's `inspect.ts`) can iterate exported keys without doing
 * its own type narrowing on `unknown`.
 */
export async function loadEntityFile(absolutePath: string): Promise<Record<string, unknown>> {
  try {
    // `tryNative: false` is intentional: when the runtime supports native
    // TS loading (Node 22.6+), jiti delegates to `import()` which carries
    // Node's process-wide ESM module cache — that cache is NOT
    // invalidated by `moduleCache: false` (which only governs jiti's own
    // CJS require-cache integration). Forcing jiti's transpile path
    // ensures we always parse the current file contents off disk.
    const jiti = createJiti(import.meta.url, {
      tryNative: false,
      fsCache: false,
      moduleCache: false,
    });
    const mod = (await jiti.import(absolutePath)) as Record<string, unknown>;
    return mod;
  } catch (err) {
    throw new EDBUserEntityLoadError(`Failed to load entity file: ${absolutePath}\n${err instanceof Error ? err.message : String(err)}`, {
      sourceFilePath: absolutePath,
      cause: err,
    });
  }
}
