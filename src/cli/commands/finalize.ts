import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('finalize [id]')
    .description(
      'Finalize the oldest pending migration (or a specific one by ID). Use --all to finalize every pending migration.',
    )
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .option('--dry-run', 'Print what would happen without writing anything')
    .option('--yes', 'Skip interactive confirmations')
    .option('--all', 'Finalize every pending migration, oldest first')
    .action(() => {
      throw new Error('Not yet implemented: finalize');
    });
};
