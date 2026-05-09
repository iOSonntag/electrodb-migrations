import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createSpinner } from '../output/spinner.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunRollbackArgs {
  cwd: string;
  configFlag?: string;
  migrationId: string;
  strategy: 'projected' | 'snapshot' | 'fill-only' | 'custom';
  yes?: boolean;
}

/**
 * RBK-02 / CLI-08 — rollback CLI.
 *
 * Calls `client.rollback(id, {strategy, yes})`. The client method:
 * - runs preconditions (RBK-01/09/10 — refusal cases throw with EDBRollbackOutOfOrderError /
 *   EDBRollbackNotPossibleError / friendly Error with code EDB_ALREADY_REVERTED / EDB_NOT_APPLIED).
 * - acquires the lock and runs the orchestrator (Plan 05-09).
 * - returns {itemCounts: RollbackItemCounts} on success.
 *
 * The CLI surfaces refusal errors via log.err(message, remediation) + exit 1.
 * The CLI surfaces the friendly already-reverted / not-applied paths as info messages + exit 0
 * (mirror create.ts's code-discrimination pattern).
 *
 * **Success summary format (WARNING 2 — pinned).** The CLI emits a single line containing the
 * canonical itemCounts key labels in fixed order:
 *
 * ```
 *   • scanned: <N>, reverted: <N>, deleted: <N>, skipped: <N>, failed: <N>
 * ```
 *
 * The literal labels `scanned:`, `reverted:`, `deleted:`, `skipped:`, `failed:` are pinned
 * by `tests/integration/cli/rollback-summary.golden.test.ts` so log-scraping consumers can
 * rely on the format.
 */
export async function runRollback(args: RunRollbackArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});

  try {
    const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

    const spinner = createSpinner(`Rolling back ${args.migrationId} (strategy: ${args.strategy})...`);
    spinner.start();
    try {
      const result = await client.rollback(args.migrationId, {
        strategy: args.strategy,
        ...(args.yes ? { yes: true } : {}),
      });
      spinner.success(c.ok(`Migration ${args.migrationId} reverted (strategy: ${args.strategy}).`));
      // WARNING 2 — pinned summary format. Literal keys must remain stable.
      log.info(
        `  • scanned: ${result.itemCounts.scanned}, reverted: ${result.itemCounts.reverted}, deleted: ${result.itemCounts.deleted}, skipped: ${result.itemCounts.skipped}, failed: ${result.itemCounts.failed}`,
      );
    } catch (err) {
      spinner.stop();
      // Friendly already-reverted / not-applied paths exit 0:
      const code = (err as Error & { code?: string }).code;
      if (code === 'EDB_ALREADY_REVERTED' || code === 'EDB_NOT_APPLIED' || code === 'EDB_MIGRATION_NOT_FOUND') {
        log.info((err as Error).message);
        return;
      }
      throw err; // bubble to action handler's catch
    }
  } finally {
    try {
      ddb.destroy();
    } catch {
      // ignore — destroy() is best-effort.
    }
  }
}

/** Register the `rollback` subcommand. */
export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <id>')
    .description('Roll back the head migration of an entity (RBK-02; head-only per RBK-01)')
    .option('--strategy <name>', 'projected | snapshot | fill-only | custom', 'projected')
    .option('--yes', 'Skip the snapshot/fill-only confirmation prompt', false)
    .action(async (id: string, opts: { strategy: string; yes?: boolean }) => {
      try {
        const validStrategies = ['projected', 'snapshot', 'fill-only', 'custom'] as const;
        type Strategy = (typeof validStrategies)[number];
        if (!(validStrategies as readonly string[]).includes(opts.strategy)) {
          const err: Error & { remediation?: string } = new Error(
            `Invalid --strategy '${opts.strategy}'. Must be one of: ${validStrategies.join(', ')}.`,
          );
          err.remediation = `Run \`electrodb-migrations rollback --help\` for the strategy list.`;
          throw err;
        }
        const configFlag = program.opts<{ config?: string }>().config;
        await runRollback({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          migrationId: id,
          strategy: opts.strategy as Strategy,
          ...(opts.yes ? { yes: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
