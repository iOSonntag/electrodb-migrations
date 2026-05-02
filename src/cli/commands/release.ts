import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('release [migrationId]')
    .description(
      'Release a deployment block left by a prior apply/rollback that ran with autoRelease=false. Pass --all to release every active block.',
    )
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .option('--all', 'Release every active deployment block')
    .action(() => {
      throw new Error('Not yet implemented: release');
    });
};
