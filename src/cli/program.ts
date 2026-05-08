import { Command } from 'commander';

/**
 * Subcommand-registration callbacks. Phase 2's plans (init/baseline/create)
 * and Phase 4's plans (apply/release/finalize/status/history) each export a
 * `registerXxxCommand(program)` function; the bin entry (`src/cli/index.ts`)
 * lazy-imports them and passes them in here.
 *
 * Phase 5+ extends this surface (rollback / unlock); Phase 7 adds validate /
 * acknowledge-removal / regenerate.
 */
export interface BuildProgramOpts {
  registerInit?: (program: Command) => void;
  registerBaseline?: (program: Command) => void;
  registerCreate?: (program: Command) => void;
  registerApply?: (program: Command) => void;
  registerRelease?: (program: Command) => void;
  registerFinalize?: (program: Command) => void;
  registerStatus?: (program: Command) => void;
  registerHistory?: (program: Command) => void;
}

/**
 * Builds the root commander program.
 *
 * - `name`, `description`, `version` set up `--help` and `--version`.
 * - `--config <path>` is the only global option for Phase 2 (CLI-01); Pitfall
 *   7 (commander v14's strict unknown-option rejection) is sidestepped because
 *   the rest of the globals (`--remote`, `--region`, `--table`) land in
 *   Phase 4 alongside the subcommands that consume them.
 * - Returns the constructed Command without parsing — callers decide whether
 *   to call `parseAsync` (production bin) or `exitOverride` + `parse` (tests).
 */
export function buildProgram(opts: BuildProgramOpts = {}): Command {
  const program = new Command()
    .name('electrodb-migrations')
    .description('First-class migration system for ElectroDB on DynamoDB')
    .version('0.1.0')
    .option('--config <path>', 'path to electrodb-migrations.config.{ts,js,mjs,cjs,json}');

  opts.registerInit?.(program);
  opts.registerBaseline?.(program);
  opts.registerCreate?.(program);
  opts.registerApply?.(program);
  opts.registerRelease?.(program);
  opts.registerFinalize?.(program);
  opts.registerStatus?.(program);
  opts.registerHistory?.(program);

  return program;
}
