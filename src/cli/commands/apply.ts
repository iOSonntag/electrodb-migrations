import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createSpinner } from '../output/spinner.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunApplyArgs {
  cwd: string;
  configFlag?: string;
  migrationId?: string;
}

/**
 * RUN-06/07/09 — apply CLI implementation.
 *
 * Calls `client.apply()` (Plan 04-11). On success, renders the apply summary
 * (Plan 04-06) to stderr. On failure, surfaces the error code via the action
 * handler's `log.err(message, remediation)` path.
 *
 * **No pending (RUN-07):** when `result.applied.length === 0`, prints
 * `log.info('No migrations to apply.')` and returns. Exit 0 (the action
 * handler does not call process.exit on success).
 *
 * **Sequence rejection (RUN-06):** the inner client throws `Error` with
 * `code === 'EDB_NOT_NEXT_PENDING'` and a `remediation` string naming the
 * actual next id. The action handler's catch block surfaces this through
 * `log.err(message, remediation)`.
 */
export async function runApply(args: RunApplyArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  // Step 1: build the AWS SDK client.
  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});

  // Step 2: build the migrations client.
  const client = createMigrationsClient({
    config,
    client: ddb,
    cwd: args.cwd,
  });

  // Step 3: spinner + apply.
  const spinner = createSpinner(
    args.migrationId !== undefined ? `Applying ${args.migrationId}...` : 'Applying pending migrations...',
  );
  spinner.start();
  let result: Awaited<ReturnType<typeof client.apply>>;
  try {
    result = await client.apply(
      args.migrationId !== undefined ? { migrationId: args.migrationId } : {},
    );
  } catch (err) {
    spinner.error('Apply failed.');
    throw err;
  }

  if (result.applied.length === 0) {
    spinner.stop();
    log.info('No migrations to apply.'); // RUN-07
    return;
  }

  // Step 4: summary (RUN-09) is written to stderr by client.apply() itself.
  // The programmatic client emits the "Next steps" checklist so it is visible
  // regardless of whether the operator invokes via CLI or programmatic API.
  spinner.success(c.ok(`Applied ${result.applied.length} migration${result.applied.length === 1 ? '' : 's'}.`));
}

/** Register the `apply` subcommand. */
export function registerApplyCommand(program: Command): void {
  program
    .command('apply')
    .description(
      'Apply pending migrations end-to-end (acquire lock, scan v1, run up(), write v2, transition to release)',
    )
    .option('--migration <id>', 'Apply only this migration (must be next pending for its entity)')
    .action(async (opts: { migration?: string }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runApply({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          ...(opts.migration !== undefined ? { migrationId: opts.migration } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
