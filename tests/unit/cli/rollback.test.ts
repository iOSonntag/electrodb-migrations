/**
 * Unit tests for `runRollback` and `registerRollbackCommand` (CLI-08 / RBK-02).
 *
 * Test cases:
 * RB-01: commander parses rollback <id> with default strategy='projected', yes=false
 * RB-02: --strategy snapshot is parsed
 * RB-03: --yes is parsed as a boolean flag
 * RB-04: invalid --strategy throws with message containing 'Invalid --strategy' and 'unknown'
 * RB-05: missing positional <id> causes commander to throw (commander.missingArgument)
 * RB-06: runRollback calls client.rollback with the correct args
 * RB-07: runRollback handles EDB_ALREADY_REVERTED as info+return (exit 0, no throw)
 * RB-08: runRollback handles EDB_NOT_APPLIED as info+return (exit 0, no throw)
 * RB-09: runRollback handles EDB_MIGRATION_NOT_FOUND as info+return (exit 0, no throw)
 * RB-10: runRollback lets EDBRollbackOutOfOrderError bubble (not caught as info)
 * RB-11: WARNING 2 — success summary contains canonical itemCounts keys in fixed order
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks (must precede imports)
// ---------------------------------------------------------------------------

vi.mock('../../../src/client/index.js', () => ({
  createMigrationsClient: vi.fn(),
}));

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

vi.mock('../../../src/cli/output/spinner.js', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createMigrationsClient } from '../../../src/client/index.js';
import { resolveCliConfig } from '../../../src/cli/shared/resolve-config.js';
import { EXIT_CODES } from '../../../src/cli/output/exit-codes.js';
import { log } from '../../../src/cli/output/log.js';
import { runRollback, registerRollbackCommand } from '../../../src/cli/commands/rollback.js';
import { buildProgram } from '../../../src/cli/program.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_CONFIG = {
  lock: { heartbeatMs: 500, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: 'test-table',
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

const STUB_ITEM_COUNTS = { scanned: 7, reverted: 5, deleted: 2, skipped: 0, failed: 0 };

function makeClient(rollbackImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ itemCounts: STUB_ITEM_COUNTS })) {
  return {
    rollback: rollbackImpl,
    apply: vi.fn(),
    history: vi.fn(),
    release: vi.fn(),
    finalize: vi.fn(),
    status: vi.fn(),
    guardedClient: vi.fn(),
    forceUnlock: vi.fn(),
    getLockState: vi.fn(),
    getGuardState: vi.fn(),
  };
}

function stubResolveConfig(): void {
  vi.mocked(resolveCliConfig).mockResolvedValue({
    config: STUB_CONFIG as never,
    configPath: '/fake/config.ts',
    cwd: '/fake',
  });
}

/**
 * Simulates the action handler's error-surfacing path:
 *   `catch (err) { log.err(message, remediation); process.exit(USER_ERROR); }`
 */
async function runRollbackViaActionHandler(args: Parameters<typeof runRollback>[0]): Promise<void> {
  try {
    await runRollback(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const remediation = (err as { remediation?: string }).remediation;
    log.err(message, remediation);
    process.exit(EXIT_CODES.USER_ERROR);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRollbackCommand — commander argument parsing', () => {
  it('RB-01: parses rollback <id> with default strategy=projected, yes=false', async () => {
    stubResolveConfig();
    const fakeRollback = vi.fn().mockResolvedValue({ itemCounts: STUB_ITEM_COUNTS });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRollback) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const program = buildProgram({ registerRollback: registerRollbackCommand });
    program.exitOverride();

    await program.parseAsync(['node', 'cli.js', 'rollback', 'mig-1']);

    expect(fakeRollback).toHaveBeenCalledWith('mig-1', expect.objectContaining({ strategy: 'projected' }));
    // yes is omitted when false (spreads an empty object)
    const callArgs = fakeRollback.mock.calls[0]?.[1] as { strategy: string; yes?: boolean } | undefined;
    expect(callArgs?.yes).toBeUndefined();
  });

  it('RB-02: --strategy snapshot is parsed correctly', async () => {
    stubResolveConfig();
    const fakeRollback = vi.fn().mockResolvedValue({ itemCounts: STUB_ITEM_COUNTS });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRollback) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const program = buildProgram({ registerRollback: registerRollbackCommand });
    program.exitOverride();

    await program.parseAsync(['node', 'cli.js', 'rollback', 'mig-1', '--strategy', 'snapshot']);

    expect(fakeRollback).toHaveBeenCalledWith('mig-1', expect.objectContaining({ strategy: 'snapshot' }));
  });

  it('RB-03: --yes is parsed as a boolean flag', async () => {
    stubResolveConfig();
    const fakeRollback = vi.fn().mockResolvedValue({ itemCounts: STUB_ITEM_COUNTS });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRollback) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const program = buildProgram({ registerRollback: registerRollbackCommand });
    program.exitOverride();

    await program.parseAsync(['node', 'cli.js', 'rollback', 'mig-1', '--yes']);

    expect(fakeRollback).toHaveBeenCalledWith('mig-1', expect.objectContaining({ yes: true }));
  });

  it('RB-04: invalid --strategy throws with message containing strategy name', async () => {
    stubResolveConfig();
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient() as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    const program = buildProgram({ registerRollback: registerRollbackCommand });
    program.exitOverride();

    await expect(
      program.parseAsync(['node', 'cli.js', 'rollback', 'mig-1', '--strategy', 'unknown']),
    ).rejects.toThrow('process.exit called');

    expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
    const stderrCalls = vi.mocked(process.stderr.write).mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('Invalid --strategy');
    expect(stderrCalls).toContain('unknown');
  });

  it('RB-05: missing positional <id> causes commander to throw (commander error)', async () => {
    const program = buildProgram({ registerRollback: registerRollbackCommand });
    program.exitOverride();

    await expect(program.parseAsync(['node', 'cli.js', 'rollback'])).rejects.toThrow();
  });
});

describe('runRollback — client delegation + error handling', () => {
  it('RB-06: calls client.rollback with the correct id and strategy', async () => {
    stubResolveConfig();
    const fakeRollback = vi.fn().mockResolvedValue({ itemCounts: STUB_ITEM_COUNTS });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRollback) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runRollback({ cwd: '/fake', migrationId: 'mig-42', strategy: 'fill-only', yes: true });

    expect(fakeRollback).toHaveBeenCalledWith('mig-42', { strategy: 'fill-only', yes: true });
  });

  it('RB-07: EDB_ALREADY_REVERTED → log.info with message, returns without throwing', async () => {
    stubResolveConfig();
    const err = Object.assign(new Error('Migration already reverted.'), { code: 'EDB_ALREADY_REVERTED' });
    vi.mocked(createMigrationsClient).mockReturnValue(
      makeClient(vi.fn().mockRejectedValue(err)) as never,
    );
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const mockExit = vi.spyOn(process, 'exit');

    await expect(runRollback({ cwd: '/fake', migrationId: 'mig-1', strategy: 'projected' })).resolves.toBeUndefined();

    expect(stderrChunks.join('')).toContain('Migration already reverted.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('RB-08: EDB_NOT_APPLIED → log.info with message, returns without throwing', async () => {
    stubResolveConfig();
    const err = Object.assign(new Error('Migration not applied.'), { code: 'EDB_NOT_APPLIED' });
    vi.mocked(createMigrationsClient).mockReturnValue(
      makeClient(vi.fn().mockRejectedValue(err)) as never,
    );
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const mockExit = vi.spyOn(process, 'exit');

    await expect(runRollback({ cwd: '/fake', migrationId: 'mig-1', strategy: 'projected' })).resolves.toBeUndefined();

    expect(stderrChunks.join('')).toContain('Migration not applied.');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('RB-09: EDB_MIGRATION_NOT_FOUND → log.info with message, returns without throwing', async () => {
    stubResolveConfig();
    const err = Object.assign(new Error("Migration 'mig-99' not found."), { code: 'EDB_MIGRATION_NOT_FOUND' });
    vi.mocked(createMigrationsClient).mockReturnValue(
      makeClient(vi.fn().mockRejectedValue(err)) as never,
    );
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const mockExit = vi.spyOn(process, 'exit');

    await expect(runRollback({ cwd: '/fake', migrationId: 'mig-99', strategy: 'projected' })).resolves.toBeUndefined();

    expect(stderrChunks.join('')).toContain("Migration 'mig-99' not found.");
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('RB-10: EDBRollbackOutOfOrderError bubbles — not caught as info', async () => {
    stubResolveConfig();
    const err = Object.assign(new Error('Rollback out of order.'), { code: 'EDB_ROLLBACK_OUT_OF_ORDER' });
    vi.mocked(createMigrationsClient).mockReturnValue(
      makeClient(vi.fn().mockRejectedValue(err)) as never,
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runRollback({ cwd: '/fake', migrationId: 'mig-1', strategy: 'projected' })).rejects.toThrow(
      'Rollback out of order.',
    );
  });
});

describe('runRollback — WARNING 2 success summary format', () => {
  it('RB-11: success summary contains all five canonical itemCounts keys in fixed order', async () => {
    stubResolveConfig();
    const itemCounts = { scanned: 10, reverted: 7, deleted: 3, skipped: 2, failed: 1 };
    vi.mocked(createMigrationsClient).mockReturnValue(
      makeClient(vi.fn().mockResolvedValue({ itemCounts })) as never,
    );
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runRollback({ cwd: '/fake', migrationId: 'mig-1', strategy: 'projected', yes: true });

    const stderr = stderrChunks.join('');
    // WARNING 2: all five literal keys must appear in fixed order on the summary line.
    expect(stderr).toContain('scanned:');
    expect(stderr).toContain('reverted:');
    expect(stderr).toContain('deleted:');
    expect(stderr).toContain('skipped:');
    expect(stderr).toContain('failed:');
    // Keys must appear in this exact order (index positions)
    const sIdx = stderr.indexOf('scanned:');
    const revIdx = stderr.indexOf('reverted:');
    const delIdx = stderr.indexOf('deleted:');
    const skpIdx = stderr.indexOf('skipped:');
    const failIdx = stderr.indexOf('failed:');
    expect(sIdx).toBeLessThan(revIdx);
    expect(revIdx).toBeLessThan(delIdx);
    expect(delIdx).toBeLessThan(skpIdx);
    expect(skpIdx).toBeLessThan(failIdx);
    // Values are present
    expect(stderr).toContain('scanned: 10');
    expect(stderr).toContain('reverted: 7');
    expect(stderr).toContain('deleted: 3');
    expect(stderr).toContain('skipped: 2');
    expect(stderr).toContain('failed: 1');
  });
});
