import { describe, expect, it } from 'vitest';

/**
 * Task 1 RED-gate test for Plan 02-09. Captures the exported-symbol
 * contract for `src/cli/commands/create.ts`:
 *  - the module exists and is loadable
 *  - it exports `registerCreateCommand` (a function that accepts a Command)
 *  - it exports `runCreate` (an async function)
 *
 * Task 2 (the behavioral suite — happy path, no-drift refusal, --force,
 * entity-not-found, bump-failure recovery, CLI-09 remediation) is appended
 * below this RED smoke after Task 1 lands.
 */
describe('src/cli/commands/create — Task 1 contract', () => {
  it('exports registerCreateCommand + runCreate', async () => {
    const mod = (await import('../../../../src/cli/commands/create.js')) as {
      registerCreateCommand?: unknown;
      runCreate?: unknown;
    };
    expect(typeof mod.registerCreateCommand).toBe('function');
    expect(typeof mod.runCreate).toBe('function');
  });
});
