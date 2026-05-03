import Table from 'cli-table3';

/**
 * Stable wrapper API around cli-table3. CLI-08.
 *
 * `style.head` is set to `[]` so cli-table3's built-in red header coloring
 * is disabled — all CLI coloring is centralized in `colors.ts` / `log.ts`.
 * Used by the `baseline` summary (Plan 09) and Phase 4's `status` / `history`
 * human-readable views. `--json` mode in those commands writes JSON to stdout
 * directly and bypasses this helper.
 */
export interface CliTable {
  toString(): string;
}

export interface CreateTableArgs {
  head: ReadonlyArray<string>;
  rows?: ReadonlyArray<ReadonlyArray<string>>;
}

export function createTable(args: CreateTableArgs): CliTable {
  const t = new Table({ head: [...args.head], style: { head: [] } });
  if (args.rows) {
    for (const row of args.rows) t.push([...row]);
  }
  return { toString: () => t.toString() };
}
