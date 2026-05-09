import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createTable } from '../output/table.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunStatusArgs {
  cwd: string;
  configFlag?: string;
  json?: boolean;
}

/**
 * CLI-03 — status CLI.
 *
 * Reads the lock row + recent `_migrations` rows via `client.status()` and
 * renders one of two outputs:
 * - default: two cli-table3 tables (Lock state + Recent migrations) to stdout
 * - `--json`: machine-readable JSON to stdout (Open Question 3 disposition:
 *   parity with history --json; trivial cost; CI scripts polling for lock state)
 *
 * Set fields (`inFlightIds`, `failedIds`, `releaseIds`) are converted to
 * comma-joined strings for the table view (Pitfall 8) and to JSON arrays
 * for the JSON view.
 *
 * Table output goes to stdout (machine-parseable per CLI-08); log.* helpers
 * go to stderr. The json flag output is also to stdout (machine-parseable).
 */
export async function runStatus(args: RunStatusArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });
  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});

  try {
    const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

    const result = await client.status();

    if (args.json) {
      // Set fields → sorted arrays for stable JSON output (Pitfall 8 + HF-3).
      const lockJson =
        result.lock === null
          ? null
          : {
              ...result.lock,
              inFlightIds: result.lock.inFlightIds ? [...result.lock.inFlightIds].sort() : [],
              failedIds: result.lock.failedIds ? [...result.lock.failedIds].sort() : [],
              releaseIds: result.lock.releaseIds ? [...result.lock.releaseIds].sort() : [],
            };
      process.stdout.write(`${JSON.stringify({ lock: lockJson, recent: result.recent }, null, 2)}\n`);
      return;
    }

    // Lock state table (1 row).
    if (result.lock === null) {
      log.info('Lock row not bootstrapped — run `electrodb-migrations init` then `baseline` first.');
    } else {
      const lockTable = createTable({
        head: ['lockState', 'lockHolder', 'lockRunId', 'lockMigrationId', 'heartbeatAt', 'inFlightIds'],
        rows: [
          [
            colorizeLockState(result.lock.lockState),
            result.lock.lockHolder ?? '—',
            result.lock.lockRunId ?? '—',
            result.lock.lockMigrationId ?? '—',
            result.lock.heartbeatAt ?? '—',
            result.lock.inFlightIds ? [...result.lock.inFlightIds].sort().join(', ') : '—',
          ],
        ],
      });
      process.stdout.write(`${lockTable.toString()}\n`);
    }

    // Recent migrations table.
    if (result.recent.length > 0) {
      const recentTable = createTable({
        head: ['id', 'entityName', 'from→to', 'status', 'appliedAt', 'finalizedAt'],
        rows: result.recent.map((r) => [
          r.id,
          r.entityName,
          `${r.fromVersion}→${r.toVersion}`,
          colorizeStatus(r.status),
          r.appliedAt ?? '—',
          r.finalizedAt ?? '—',
        ]),
      });
      process.stdout.write(`${recentTable.toString()}\n`);
    }
  } finally {
    // WR-07 — release the SDK's HTTP/socket pool.
    try {
      ddb.destroy();
    } catch {
      // ignore — destroy() is best-effort.
    }
  }
}

export function colorizeLockState(state: string): string {
  if (state === 'free') return c.dim(state);
  if (state === 'failed' || state === 'dying') return c.err(state);
  if (state === 'release') return c.warn(state);
  return c.ok(state);
}

export function colorizeStatus(status: string): string {
  if (status === 'applied') return c.ok(status);
  if (status === 'finalized') return c.dim(status);
  if (status === 'failed') return c.err(status);
  if (status === 'reverted') return c.warn(status);
  return status;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show the current lock state and recent migrations (CLI-03)')
    .option('--json', 'Emit machine-readable JSON to stdout instead of a table', false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runStatus({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          ...(opts.json ? { json: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
