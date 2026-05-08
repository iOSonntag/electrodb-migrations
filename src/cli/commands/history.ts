import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createMigrationsClient } from '../../client/index.js';
import { formatHistoryJson } from '../../runner/index.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createTable } from '../output/table.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunHistoryArgs {
  cwd: string;
  configFlag?: string;
  entity?: string;
  json?: boolean;
}

/**
 * CLI-04 — history CLI.
 *
 * `history` prints a cli-table3 table to stdout.
 * `history --entity <name>` filters rows by entity name.
 * `history --json` emits the formatHistoryJson output (Plan 04-06 contract):
 *   - top-level array; ISO-8601 dates verbatim; Sets→sorted arrays.
 *   - Suitable for `jq '.[] | select(.status == "failed")'`.
 *
 * Table output goes to stdout (machine-parseable per CLI-08); log.* helpers
 * go to stderr.
 */
export async function runHistory(args: RunHistoryArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });
  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});
  const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

  const rows = await client.history(args.entity !== undefined ? { entity: args.entity } : undefined);

  if (args.json) {
    process.stdout.write(formatHistoryJson(rows, args.entity !== undefined ? { entity: args.entity } : {}));
    return;
  }

  if (rows.length === 0) {
    log.info(
      args.entity !== undefined
        ? `No migrations recorded for entity '${args.entity}'.`
        : 'No migrations recorded.',
    );
    return;
  }

  // Sort ascending by id (id contains timestamp prefix → chronological order).
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const table = createTable({
    head: ['id', 'entityName', 'from→to', 'status', 'appliedAt', 'finalizedAt', 'scanned/migrated/deleted/skipped/failed'],
    rows: sorted.map((r) => [
      r.id,
      r.entityName,
      `${r.fromVersion}→${r.toVersion}`,
      r.status,
      r.appliedAt ?? '—',
      r.finalizedAt ?? '—',
      r.itemCounts
        ? `${r.itemCounts.scanned}/${r.itemCounts.migrated}/${r.itemCounts.deleted ?? 0}/${r.itemCounts.skipped}/${r.itemCounts.failed}`
        : '—',
    ]),
  });
  process.stdout.write(`${table.toString()}\n`);
}

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Print the full migration log (CLI-04)')
    .option('--entity <name>', 'Filter to migrations of a single entity')
    .option('--json', 'Emit machine-readable JSON to stdout instead of a table', false)
    .action(async (opts: { entity?: string; json?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runHistory({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          ...(opts.entity !== undefined ? { entity: opts.entity } : {}),
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
