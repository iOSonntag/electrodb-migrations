import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../../src/cli/program.js';

describe('buildProgram (CLI-01 — global --config flag, FND-04 — bin program)', () => {
  it('returns a commander Command named "electrodb-migrations"', () => {
    const program = buildProgram();
    expect(program).toBeInstanceOf(Command);
    expect(program.name()).toBe('electrodb-migrations');
  });

  it('declares version "0.1.0"', () => {
    const program = buildProgram();
    expect(program.version()).toBe('0.1.0');
  });

  it('registers a global --config option', () => {
    const program = buildProgram();
    const flags = program.options.map((o) => o.flags);
    expect(flags.some((f) => f.includes('--config'))).toBe(true);
  });

  it('registers no subcommands when no register callbacks are provided', () => {
    const program = buildProgram();
    // commander always exposes a built-in `help` command — filter it out.
    const userCommands = program.commands.filter((c) => c.name() !== 'help');
    expect(userCommands).toHaveLength(0);
  });

  it('invokes registerInit / registerBaseline / registerCreate callbacks with the program', () => {
    let baselineCalled = false;
    let createCalled = false;
    const program = buildProgram({
      registerInit: (p) => {
        p.command('init').action(() => {});
      },
      registerBaseline: (p) => {
        baselineCalled = true;
        p.command('baseline').action(() => {});
      },
      registerCreate: (p) => {
        createCalled = true;
        p.command('create').action(() => {});
      },
    });
    expect(baselineCalled).toBe(true);
    expect(createCalled).toBe(true);
    const subcommandNames = program.commands.map((c) => c.name()).filter((n) => n !== 'help');
    expect(subcommandNames).toContain('init');
    expect(subcommandNames).toContain('baseline');
    expect(subcommandNames).toContain('create');
  });

  it('parses --version without throwing when exitOverride is set (returns 0.1.0)', () => {
    const program = buildProgram();
    program.exitOverride();
    // commander prints the version to stdout. Silence the write so the test
    // output stays clean while still asserting on the exit-override message.
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let caught: unknown;
    try {
      program.parse(['--version'], { from: 'user' });
    } catch (e) {
      // commander throws CommanderError on --version under exitOverride. The
      // thrown error's message carries the version string.
      caught = e;
    }
    const writeCallCount = stdoutSpy.mock.calls.length;
    stdoutSpy.mockRestore();
    expect(caught).toBeDefined();
    const msg = (caught as Error).message;
    expect(msg).toContain('0.1.0');
    // Confirm commander attempted to write the version to stdout.
    expect(writeCallCount).toBeGreaterThan(0);
  });
});
