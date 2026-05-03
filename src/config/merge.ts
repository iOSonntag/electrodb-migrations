import {
  DEFAULT_ENTITIES_PATH,
  DEFAULT_GUARD,
  DEFAULT_KEY_NAMES,
  DEFAULT_LOCK,
  DEFAULT_MIGRATIONS_PATH,
  DEFAULT_RUNNER,
} from './defaults.js';
import type { MigrationsConfig, ResolvedConfig } from './types.js';

/**
 * Override precedence (CFG-11): runtime arg > CLI flag > config field >
 * built-in default. The merge is intentionally FLAT — sections (lock, guard,
 * keyNames, runner, remote) are spread once each. No deep-merge library;
 * this is ~50 lines (Don't-Hand-Roll table).
 *
 * The CLI-flag layer is applied by Plan 02's CLI plumbing in Phase 2 by
 * passing the flag-derived overrides to `resolveConfig`. For Phase 1, the
 * merge supports two layers (file + overrides); the CLI / runtime callers
 * compose flag and runtime args into the `overrides` argument.
 */
export function resolveConfig(fileConfig: MigrationsConfig, overrides: Partial<MigrationsConfig> = {}): ResolvedConfig {
  const entitiesFromFile =
    fileConfig.entities === undefined
      ? null
      : Array.isArray(fileConfig.entities)
        ? [...fileConfig.entities]
        : [fileConfig.entities as string];
  const entitiesFromOverride =
    overrides.entities === undefined
      ? null
      : Array.isArray(overrides.entities)
        ? [...overrides.entities]
        : [overrides.entities as string];

  return {
    entities: entitiesFromOverride ?? entitiesFromFile ?? [DEFAULT_ENTITIES_PATH],
    migrations: overrides.migrations ?? fileConfig.migrations ?? DEFAULT_MIGRATIONS_PATH,
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
    // Per-section spread so overriding only `remote.url` doesn't drop
    // `remote.apiKey` from the file (entries #3 / #5). Yields `undefined`
    // when both layers are nullish — NOT `{}` — so downstream consumers can
    // rely on `remote === undefined` meaning "no remote configured."
    remote:
      fileConfig.remote || overrides.remote
        ? { ...fileConfig.remote, ...overrides.remote }
        : undefined,
    migrationStartVersions: {
      ...fileConfig.migrationStartVersions,
      ...overrides.migrationStartVersions,
    },
  };
}
