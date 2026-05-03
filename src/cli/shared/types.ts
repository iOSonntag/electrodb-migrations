import type { ResolvedConfig } from '../../config/types.js';

/**
 * Per-command context built once by the CLI's top-level wrapper after
 * `resolveCliConfig` succeeds. Plans 08 (init/baseline) and 09 (create) — and
 * Phase 4+ commands — receive this from the program runner so they don't
 * re-resolve the config themselves.
 *
 * Note: `init` is the lone exception — it runs BEFORE a config exists, so it
 * does not receive a CommandContext.
 */
export interface CommandContext {
  config: ResolvedConfig;
  configPath: string;
  cwd: string;
}
