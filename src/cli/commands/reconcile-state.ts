import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('reconcile-state')
    .description(
      'Rebuild the aggregate _migration_state row from per-migration history. Refuses to run while a migration is in progress; safe to run any time otherwise. Preserves deploymentBlockedIds (operator intent), rebuilds failedIds and inFlightIds from the audit table.',
    )
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .action(() => {
      throw new Error('Not yet implemented: reconcile-state');
    });
};
