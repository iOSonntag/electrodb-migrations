import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createSpinner } from '../output/spinner.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunReleaseArgs {
  cwd: string;
  configFlag?: string;
}

/**
 * REL-01/02 — release CLI.
 *
 * Calls `client.release()` (Plan 04-11). The client returns
 * `{cleared: false, reason: 'no-active-release-lock'}` for the idempotent
 * no-op path; the CLI prints `log.info('No active release-mode lock —
 * nothing to do.')` and exits 0. (REL-02.)
 *
 * For the premature path (lock is in apply/finalize/rollback/failed), the
 * client throws an Error with `code === 'EDB_RELEASE_PREMATURE'` and a
 * remediation. The CLI's action handler surfaces via `log.err`.
 */
export async function runRelease(args: RunReleaseArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});

  try {
    const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

    const spinner = createSpinner('Clearing release-mode lock...');
    spinner.start();
    const result = await client.release();
    if (!result.cleared) {
      spinner.stop();
      log.info('No active release-mode lock — nothing to do.'); // REL-02
      return;
    }
    spinner.success('Release-mode lock cleared.');
  } finally {
    // WR-07 — release the SDK's HTTP/socket pool.
    try {
      ddb.destroy();
    } catch {
      // ignore — destroy() is best-effort.
    }
  }
}

/** Register the `release` subcommand. No flags. */
export function registerReleaseCommand(program: Command): void {
  program
    .command('release')
    .description('Clear the release-mode lock after deploying code (REL-01)')
    .action(async () => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runRelease({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
