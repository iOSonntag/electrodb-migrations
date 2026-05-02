import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('apply')
    .description('Run all pending migrations (oldest first)')
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .option('--dry-run', 'Print what would happen without writing anything')
    .option('--yes', 'Skip interactive confirmations')
    .option(
      '--auto-release',
      'Release the deployment block automatically on success. Default OFF: a successful apply leaves a deployment block on the migration that the guard wrapper enforces until `electrodb-migrations release <id>` is called. The off-by-default behavior supports the migrate -> deploy new code -> release workflow; pass --auto-release if you do not need the deploy gate.',
      false,
    )
    .action(() => {
      throw new Error('Not yet implemented: apply');
    });
};
