import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('diff')
    .description('Show schema diff for current drift (no files written)')
    .option('--config <path>', 'Path to config file')
    .option('--json', 'Machine-readable output')
    .action(() => {
      throw new Error('Not yet implemented: diff');
    });
};
