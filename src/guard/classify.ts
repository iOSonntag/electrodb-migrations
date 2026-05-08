/**
 * Read/write classifier for the guard's `blockMode: 'writes-only'` allowlist
 * (GRD-05).
 *
 * Match against `context.commandName` from the AWS SDK middleware's second
 * argument — stable contract across SDK v3 minor versions per RESEARCH.md A4.
 *
 * The allowlist covers BOTH the raw `@aws-sdk/client-dynamodb` command classes
 * (e.g. `GetItemCommand`) AND the `@aws-sdk/lib-dynamodb` DocumentClient
 * wrappers (e.g. `GetCommand`). Set semantics dedup any name shared between
 * the two packages (Query/Scan are not re-exported by lib-dynamodb so their
 * names match on a single entry).
 */
const READ_COMMANDS: ReadonlySet<string> = new Set([
  // @aws-sdk/client-dynamodb (raw)
  'GetItemCommand',
  'QueryCommand',
  'ScanCommand',
  'BatchGetItemCommand',
  'TransactGetItemsCommand',
  // @aws-sdk/lib-dynamodb (DocumentClient wrappers)
  'GetCommand',
  'BatchGetCommand',
  'TransactGetCommand',
]);

/**
 * Returns `true` iff the command's class name (`context.commandName`) is one
 * of the read-only DDB commands. Used by the guard middleware (`wrap.ts`)
 * when `config.guard.blockMode === 'writes-only'`.
 *
 * Returns `false` for `undefined` (a malformed middleware context) and any
 * unknown command name — the safe default is "treat as a write" so the guard
 * still gates unknown commands during a migration.
 */
export function isReadCommand(commandName: string | undefined): boolean {
  if (commandName === undefined) return false;
  return READ_COMMANDS.has(commandName);
}
