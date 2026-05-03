import { DEFAULT_GUARD, DEFAULT_KEY_NAMES, DEFAULT_LOCK, DEFAULT_RUNNER } from './defaults.js';
import type { MigrationsConfig, ResolvedConfig } from './types.js';

/**
 * Override precedence (CFG-11): runtime arg > CLI flag > config field >
 * built-in default. The merge is intentionally FLAT — sections (lock, guard,
 * keyNames, runner) are spread once each. No deep-merge library; this is
 * ~40 lines (Don't-Hand-Roll table).
 *
 * The CLI-flag layer is applied by Plan 02's CLI plumbing in Phase 2 by
 * passing the flag-derived overrides to `resolveConfig`. For Phase 1, the
 * merge supports two layers (file + overrides); the CLI / runtime callers
 * compose flag and runtime args into the `overrides` argument.
 */
export function resolveConfig(fileConfig: MigrationsConfig, overrides: Partial<MigrationsConfig> = {}): ResolvedConfig {
  const entitiesFromFile = Array.isArray(fileConfig.entities) ? [...fileConfig.entities] : [fileConfig.entities as string];
  const entitiesFromOverride = overrides.entities ? (Array.isArray(overrides.entities) ? [...overrides.entities] : [overrides.entities as string]) : null;

  return {
    entities: entitiesFromOverride ?? entitiesFromFile,
    migrations: overrides.migrations ?? fileConfig.migrations,
    region: overrides.region ?? fileConfig.region,
    tableName: overrides.tableName ?? fileConfig.tableName,
    keyNames: {
      ...DEFAULT_KEY_NAMES,
      ...fileConfig.keyNames,
      ...overrides.keyNames,
    },
    lock: {
      ...DEFAULT_LOCK,
      ...fileConfig.lock,
      ...overrides.lock,
    },
    guard: {
      ...DEFAULT_GUARD,
      ...fileConfig.guard,
      ...overrides.guard,
    },
    runner: {
      ...DEFAULT_RUNNER,
      ...fileConfig.runner,
      ...overrides.runner,
    },
    remote: overrides.remote ?? fileConfig.remote,
    migrationStartVersions: {
      ...fileConfig.migrationStartVersions,
      ...overrides.migrationStartVersions,
    },
  };
}
