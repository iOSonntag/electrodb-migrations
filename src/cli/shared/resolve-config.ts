import { isAbsolute, resolve } from 'node:path';
import { validateConfigInvariants } from '../../config/invariants.js';
import { findConfigPath, loadConfigFile } from '../../config/load.js';
import { resolveConfig } from '../../config/merge.js';
import type { MigrationsConfig, ResolvedConfig } from '../../config/types.js';
import { EDBMigrationError } from '../../errors/base.js';

/**
 * Internal error class — raised before any load attempt when no
 * `electrodb-migrations.config.{ts,js,...}` is discoverable in the operator's
 * `cwd`. Distinct from `EDBConfigLoadError` (which wraps jiti load failures
 * for an explicit path that exists but cannot be evaluated). Not re-exported
 * from `src/index.ts`.
 */
export class EDBConfigNotFoundError extends EDBMigrationError {
  readonly code = 'EDB_CONFIG_NOT_FOUND' as const;
}

export interface ResolveCliConfigArgs {
  /** Absolute or cwd-relative path provided by the user via the `--config` flag. */
  configFlag?: string;
  /** Working directory used for cwd-relative resolution. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface ResolvedCliConfig {
  config: ResolvedConfig;
  configPath: string;
  cwd: string;
}

/**
 * Composes Phase 1's config layer (load → merge → invariants) into a single
 * helper every CLI command can call before doing any other work. CLI-01.
 *
 * Resolution rules:
 * - When `configFlag` is provided, the path is treated as absolute or
 *   cwd-relative. The file MUST exist; missing-file errors surface as
 *   `EDBConfigLoadError` (Phase 1 wraps the underlying ENOENT).
 * - When `configFlag` is absent, the standard config-name search runs in
 *   `cwd` (`findConfigPath`); if nothing matches, `EDBConfigNotFoundError`
 *   is thrown with the cwd in the message and details so the operator can
 *   tell exactly where the framework looked.
 * - Once a path is resolved, the file is loaded, defaults are merged
 *   (`resolveConfig`), and the §5.3 timing invariant is asserted
 *   (`validateConfigInvariants`).
 */
export async function resolveCliConfig(args: ResolveCliConfigArgs = {}): Promise<ResolvedCliConfig> {
  const cwd = args.cwd ?? process.cwd();
  let configPath: string | null;
  if (args.configFlag !== undefined) {
    configPath = isAbsolute(args.configFlag) ? args.configFlag : resolve(cwd, args.configFlag);
  } else {
    configPath = findConfigPath(cwd);
  }
  if (!configPath) {
    throw new EDBConfigNotFoundError(`No electrodb-migrations.config.{ts,mts,cts,js,mjs,cjs,json} found in ${cwd}. Run \`electrodb-migrations init\` to scaffold one.`, { cwd });
  }
  const raw = (await loadConfigFile(configPath)) as MigrationsConfig;
  const resolved = resolveConfig(raw);
  validateConfigInvariants(resolved);
  return { config: resolved, configPath, cwd };
}
