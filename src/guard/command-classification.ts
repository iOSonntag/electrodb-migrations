// AWS SDK v3 / lib-dynamodb command names that are pure reads.
// Used by the wrapper's blockMode='writes-only' path. Anything not in this
// set is conservatively treated as a write (including PartiQL Execute*
// commands, which can be either, and TransactWrite which is always a write).
const READ_COMMANDS = new Set<string>([
  'GetCommand',
  'GetItemCommand',
  'BatchGetCommand',
  'BatchGetItemCommand',
  'QueryCommand',
  'ScanCommand',
  'TransactGetCommand',
  'TransactGetItemsCommand',
]);

export const isReadCommand = (commandName: string | undefined): boolean =>
  commandName !== undefined && READ_COMMANDS.has(commandName);
