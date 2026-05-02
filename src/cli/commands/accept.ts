import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('accept')
    .description('Treat current drift as a no-op; bump snapshot without scaffolding a migration')
    .option('--config <path>', 'Path to config file')
    .option('--entity <name>', 'Entity name to accept drift for')
    .action(() => {
      throw new Error('Not yet implemented: accept');
    });
};
