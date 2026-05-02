import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('status')
    .description('Show applied vs pending vs drift, per entity')
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .option('--strict', 'Exit non-zero if drift exists without a scaffolded migration')
    .action(() => {
      throw new Error('Not yet implemented: status');
    });
};
