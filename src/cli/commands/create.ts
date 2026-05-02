import type { Command } from 'commander';

export const register = (program: Command): void => {
  program
    .command('create')
    .description('Scaffold a migration from current drift')
    .option('--config <path>', 'Path to config file')
    .option('--entity <name>', 'Entity name to scaffold migration for')
    .option('--name <slug>', 'Kebab-slug suffix for the migration ID')
    .action(() => {
      throw new Error('Not yet implemented: create');
    });
};
