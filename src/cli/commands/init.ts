import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { snapshotPaths } from '../../snapshot/paths.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';

const DEFAULT_CONFIG_FILENAME = 'electrodb-migrations.config.ts';

/**
 * The default `electrodb-migrations.config.ts` content scaffolded by `init`.
 * Kept as a const so the unit test can byte-compare. Q6 lock — `init` does
 * NOT create a starter entity file under `src/entities/`; the operator does
 * that themselves and points `entities` at the chosen path.
 */
const DEFAULT_CONFIG_CONTENT = [
  "import { defineConfig } from 'electrodb-migrations';",
  '',
  'export default defineConfig({',
  "  entities: 'src/entities',",
  "  migrations: 'src/database/migrations',",
  "  tableName: () => process.env.TABLE_NAME ?? 'app_table',",
  '});',
  '',
].join('\n');

export interface RunInitArgs {
  /** Project root — usually `process.cwd()`. The init scaffold lands here. */
  cwd: string;
  /**
   * When true, overwrite an existing `electrodb-migrations.config.ts`. The
   * scope is EXPLICITLY narrow: only the config file is overwritten;
   * `.electrodb-migrations/snapshots/` and `src/database/migrations/` contents
   * are NEVER modified by `init`, force or not (T-02-08-02).
   */
  force: boolean;
}

/**
 * Bootstrap an electrodb-migrations layout. Idempotent for directory creation;
 * refuses to clobber an existing config file unless `force` is true.
 *
 * Pitfall 6: the refusal-without-force / overwrite-with-force semantics are
 * load-bearing for INI-02. The error message names the file the operator is
 * about to lose so they can decide whether to delete it manually or pass
 * `--force`.
 *
 * Q6 lock (RESEARCH §Open Question Q6): `init` does NOT create a starter
 * entity file. Generating one would force the operator into the framework's
 * style choices (single-file vs multi-file, map types, etc.) at the worst
 * possible time — before they have any concrete entity domain in mind.
 */
export async function runInit(args: RunInitArgs): Promise<void> {
  const cwd = resolve(args.cwd);
  const paths = snapshotPaths(cwd);
  const migrationsDir = resolve(cwd, 'src/database/migrations');
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILENAME);

  // Step 1+2: framework state + per-entity snapshots dir.
  mkdirSync(paths.snapshotsDir, { recursive: true });
  // Step 3: conventional migrations location. `init` does not consult
  // `config.migrations` because the config doesn't exist yet — the user can
  // edit the path post-init if they want a different layout.
  mkdirSync(migrationsDir, { recursive: true });

  // Step 4: config file existence + force gate.
  if (existsSync(configPath)) {
    if (!args.force) {
      const err = new Error(`${DEFAULT_CONFIG_FILENAME} already exists.`);
      // CLI-09 remediation suffix delivered to the wrapping action handler
      // for human-readable formatting at the operator's terminal.
      Object.assign(err, {
        remediation: 'Re-run with --force to overwrite (your edits will be lost) or delete the file and re-run.',
      });
      throw err;
    }
    log.warn(`Overwriting existing ${DEFAULT_CONFIG_FILENAME} (--force)`);
  }

  // Step 5: write the default config.
  writeFileSync(configPath, DEFAULT_CONFIG_CONTENT, 'utf8');

  // Step 6: success + numbered next-steps.
  log.ok(`Initialized electrodb-migrations in ${cwd}`);
  log.info('');
  log.info('Next steps:');
  log.info('  1. Edit electrodb-migrations.config.ts to set tableName + region');
  log.info('  2. Define your ElectroDB entities under src/entities/');
  log.info('  3. Run `electrodb-migrations baseline` to snapshot current shapes');
}

/**
 * Register the `init` subcommand on the commander program. Keeps the
 * command's wiring (option flags, error handling, exit codes) here so
 * `runInit` itself stays testable without commander in the loop.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Bootstrap electrodb-migrations in the current project')
    .option('-f, --force', 'Overwrite existing electrodb-migrations.config.ts', false)
    .action(async (opts: { force?: boolean }) => {
      try {
        await runInit({ cwd: process.cwd(), force: opts.force ?? false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
