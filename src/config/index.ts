export { defineConfig } from './define.js';
export type { MigrationsConfig } from './types.js';
export type { ResolvedConfig } from './types.js';
export {
  DEFAULT_GUARD,
  DEFAULT_KEY_NAMES,
  DEFAULT_LOCK,
  DEFAULT_RUNNER,
} from './defaults.js';
export { findConfigPath, loadConfigFile, EDBConfigLoadError } from './load.js';
export { resolveConfig } from './merge.js';
export {
  validateConfigInvariants,
  EDBConfigInvariantViolationError,
} from './invariants.js';
