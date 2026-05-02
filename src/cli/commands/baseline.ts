import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('baseline')
    .description('Snapshot all current entities; mark as no migration needed')
    .option('--config <path>', 'Path to config file')
    .action(() => {
      throw new Error('Not yet implemented: baseline');
    });
};
