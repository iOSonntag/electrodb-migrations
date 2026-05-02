import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('plan')
    .description('Dry-run: count items, estimate cost, run transforms on samples')
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .action(() => {
      throw new Error('Not yet implemented: plan');
    });
};
