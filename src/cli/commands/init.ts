import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('init')
    .description('Scaffold .electrodb-migrations/ + snapshots/ + migrations/')
    .option('--config <path>', 'Path to config file')
    .action(() => {
      throw new Error('Not yet implemented: init');
    });
};
