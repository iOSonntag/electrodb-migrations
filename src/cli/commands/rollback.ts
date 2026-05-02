import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('rollback')
    .description('Undo the most recent applied-but-not-finalized migration')
    .option('--config <path>', 'Path to config file')
    .option('--table <name>', 'Override target DynamoDB table')
    .option('--region <name>', 'Override AWS region')
    .option('--profile <name>', 'Override AWS profile')
    .option('--json', 'Machine-readable output')
    .option('--dry-run', 'Print what would happen without writing anything')
    .option('--yes', 'Skip interactive confirmations')
    .option(
      '--auto-release',
      'Release the deployment block automatically on success. Default OFF: a successful rollback leaves a deployment block on the migration that the guard wrapper enforces until `electrodb-migrations release <id>` is called. The off-by-default behavior supports the rollback -> deploy old code -> release workflow; pass --auto-release if you do not need the deploy gate.',
      false,
    )
    .action(() => {
      throw new Error('Not yet implemented: rollback');
    });
};
