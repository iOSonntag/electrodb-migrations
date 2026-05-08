import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createSpinner } from '../output/spinner.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunFinalizeArgs {
  cwd: string;
  configFlag?: string;
  migrationId?: string;
  all?: boolean;
}

/**
 * FIN-01/02/03/04 — finalize CLI.
 *
 * Two modes:
 * - `finalize <id>`: deletes v1 records for the named migration; marks `_migrations.status='finalized'`.
 * - `finalize --all`: enumerates `status='applied'` migrations and finalizes each in sequence
 *   (each is its own lock cycle; FIN-02). No automatic bake-window — operator's responsibility.
 *
 * **Exactly one** of `<id>` or `--all` must be provided. The action handler validates this
 * because commander does not distinguish the two cases at the option layer.
 *
 * **FIN-04 — finalize is irreversible.** No CLI confirmation prompt in v0.1 (operator-deliberate
 * action). Phase 5+ may add a warning if `--strategy projected` rollback would be the only
 * recovery path.
 */
export async function runFinalize(args: RunFinalizeArgs): Promise<void> {
  // Validation: exactly one of {migrationId, all}.
  if (args.migrationId === undefined && !args.all) {
    const err: Error & { remediation?: string } = new Error('finalize requires either <id> or --all.');
    err.remediation = 'Run `electrodb-migrations finalize <id>` for a single migration, or `--all` to finalize every applied migration.';
    throw err;
  }
  if (args.migrationId !== undefined && args.all) {
    const err: Error & { remediation?: string } = new Error('finalize <id> and --all are mutually exclusive.');
    err.remediation = 'Pick one: a specific id OR --all.';
    throw err;
  }

  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});
  const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

  const target = args.migrationId !== undefined ? args.migrationId : '__all__';
  const spinner = createSpinner(args.all ? 'Finalizing all applied migrations...' : `Finalizing ${target}...`);
  spinner.start();
  const result = await client.finalize(args.all ? { all: true } : args.migrationId!);
  if (result.finalized.length === 0) {
    spinner.stop();
    log.info('No applied migrations to finalize.');
    return;
  }
  spinner.success(c.ok(`Finalized ${result.finalized.length} migration${result.finalized.length === 1 ? '' : 's'}.`));
  for (const f of result.finalized) {
    log.info(`  • ${f.migId}: ${f.itemCounts.scanned} scanned, ${f.itemCounts.deleted} deleted, ${f.itemCounts.skipped} skipped, ${f.itemCounts.failed} failed`);
  }
}

/** Register the `finalize` subcommand. */
export function registerFinalizeCommand(program: Command): void {
  program
    .command('finalize [id]')
    .description('Delete v1 records for a finalized migration (--all to finalize every applied migration)')
    .option('--all', 'Finalize every applied migration in sequence', false)
    .action(async (id: string | undefined, opts: { all?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runFinalize({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          ...(id !== undefined ? { migrationId: id } : {}),
          ...(opts.all ? { all: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
