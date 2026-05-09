/**
 * Unit tests for `runUnlock`, `registerUnlockCommand`, and `renderLockTable` (CLI-05/06/07).
 *
 * Test cases:
 * UL-01: commander REQUIRES --run-id (missing --run-id → commander error)
 * UL-02: commander REQUIRES --run-id even with --yes (VALIDATION invariant 8)
 * UL-03: --run-id <X> is parsed
 * UL-04: --run-id <X> --yes are both parsed; yes === true
 * UL-05: early-exit when lock is 'free' — forceUnlock NOT called
 * UL-06: early-exit when lock is null — forceUnlock NOT called
 * UL-07: renderLockTable golden test — all 6 field labels present + values (VALIDATION invariant 9)
 * UL-08: confirms interactively when --yes is absent (readline mocked to return 'y')
 * UL-09: skips readline when --yes is set
 * UL-10: aborts when user types 'n' — forceUnlock NOT called, log.info('Aborted')
 * UL-11: warns when priorState is an active state (apply)
 * UL-12: BLOCKER 3 — bundle.migrations.patch called on priorState=apply path
 * UL-13: BLOCKER 3 — patch rejection doesn't propagate; console.error emitted; warn still logged
 * UL-14: BLOCKER 3 — NO patch when priorState='free'
 * UL-15: BLOCKER 3 — NO patch when priorState='release'
 * UL-16: BLOCKER 3 — NO patch when lockMigrationId is undefined
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

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue('y'),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createMigrationsClient } from '../../../src/client/index.js';
import { resolveCliConfig } from '../../../src/cli/shared/resolve-config.js';
import { createInterface } from 'node:readline/promises';
import { EXIT_CODES } from '../../../src/cli/output/exit-codes.js';
import { log } from '../../../src/cli/output/log.js';
import { runUnlock, registerUnlockCommand, renderLockTable } from '../../../src/cli/commands/unlock.js';
import { buildProgram } from '../../../src/cli/program.js';
import type { LockRowSnapshot } from '../../../src/lock/index.js';

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

/** A minimal lock row snapshot that is not 'free'. */
function makeActiveLockRow(overrides: Partial<LockRowSnapshot> = {}): LockRowSnapshot {
  return {
    id: 'state',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    lockState: 'apply',
    lockHolder: 'test-host:1234',
    lockRunId: 'run-abc',
    lockMigrationId: 'mig-X',
    lockAcquiredAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 minutes ago
    heartbeatAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
    ...overrides,
  };
}

/**
 * Makes a mock MigrationsClient with full method stubs.
 * The __bundle is exposed as a non-enumerable internal property (mirrors Plan 05-10).
 */
function makeClient(overrides: {
  getLockState?: ReturnType<typeof vi.fn>;
  forceUnlock?: ReturnType<typeof vi.fn>;
  bundleMigrationsPatch?: ReturnType<typeof vi.fn>;
} = {}) {
  const goFn = vi.fn().mockResolvedValue({});
  const setFn = vi.fn().mockReturnValue({ go: goFn });
  const patchFn = overrides.bundleMigrationsPatch ?? vi.fn().mockReturnValue({ set: setFn });

  const client = {
    apply: vi.fn(),
    history: vi.fn(),
    release: vi.fn(),
    finalize: vi.fn(),
    status: vi.fn(),
    rollback: vi.fn(),
    guardedClient: vi.fn(),
    getGuardState: vi.fn(),
    getLockState: overrides.getLockState ?? vi.fn().mockResolvedValue(makeActiveLockRow()),
    forceUnlock: overrides.forceUnlock ?? vi.fn().mockResolvedValue({ priorState: 'apply' }),
  };

  // Attach __bundle as non-enumerable (mirrors create-migrations-client.ts)
  Object.defineProperty(client, '__bundle', {
    value: { migrations: { patch: patchFn } },
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return { client, patchFn, setFn, goFn };
}

function stubResolveConfig(): void {
  vi.mocked(resolveCliConfig).mockResolvedValue({
    config: STUB_CONFIG as never,
    configPath: '/fake/config.ts',
    cwd: '/fake',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Commander parsing tests
// ---------------------------------------------------------------------------

describe('registerUnlockCommand — commander argument parsing', () => {
  it('UL-01: commander REQUIRES --run-id (missing --run-id → commander error)', async () => {
    const program = buildProgram({ registerUnlock: registerUnlockCommand });
    program.exitOverride();

    // Commander should throw when required option is missing
    await expect(program.parseAsync(['node', 'cli.js', 'unlock'])).rejects.toThrow();
  });

  it('UL-02: commander REQUIRES --run-id even with --yes (VALIDATION invariant 8)', async () => {
    const program = buildProgram({ registerUnlock: registerUnlockCommand });
    program.exitOverride();

    // Even with --yes, --run-id is still required
    await expect(program.parseAsync(['node', 'cli.js', 'unlock', '--yes'])).rejects.toThrow();
  });

  it('UL-03: --run-id <X> is parsed and passed to runUnlock', async () => {
    stubResolveConfig();
    const { client, patchFn } = makeClient({
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'apply' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Mock readline to return 'y'
    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close: vi.fn(),
    } as never);

    const program = buildProgram({ registerUnlock: registerUnlockCommand });
    program.exitOverride();

    await program.parseAsync(['node', 'cli.js', 'unlock', '--run-id', 'my-run-id']);

    expect(client.forceUnlock).toHaveBeenCalledWith({ runId: 'my-run-id', yes: true });
    // patchFn called because priorState='apply' is active
    expect(patchFn).toHaveBeenCalled();
  });

  it('UL-04: --run-id <X> --yes: both parsed, yes===true, readline not called', async () => {
    stubResolveConfig();
    const { client } = makeClient({
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'release' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const program = buildProgram({ registerUnlock: registerUnlockCommand });
    program.exitOverride();

    await program.parseAsync(['node', 'cli.js', 'unlock', '--run-id', 'run-99', '--yes']);

    expect(client.forceUnlock).toHaveBeenCalledWith({ runId: 'run-99', yes: true });
    expect(createInterface).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runUnlock — early-exit paths
// ---------------------------------------------------------------------------

describe('runUnlock — early-exit paths', () => {
  it('UL-05: early-exit when lock is free — forceUnlock NOT called, info logged', async () => {
    stubResolveConfig();
    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue({ lockState: 'free', id: 'state', schemaVersion: 1, updatedAt: '' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    expect(client.forceUnlock).not.toHaveBeenCalled();
    expect(stderrChunks.join('')).toContain('Lock is already free');
  });

  it('UL-06: early-exit when lock is null — forceUnlock NOT called, info logged', async () => {
    stubResolveConfig();
    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    expect(client.forceUnlock).not.toHaveBeenCalled();
    expect(stderrChunks.join('')).toContain('Lock is already free');
  });
});

// ---------------------------------------------------------------------------
// renderLockTable golden test (VALIDATION invariant 9)
// ---------------------------------------------------------------------------

describe('renderLockTable — field label golden test (CLI-06 / VALIDATION invariant 9)', () => {
  it('UL-07: rendered table contains all 6 field labels and corresponding values', () => {
    const now = new Date().toISOString();
    const acquiredAt = new Date(Date.now() - 3 * 60_000).toISOString(); // 3 minutes ago
    const heartbeatAt = new Date(Date.now() - 45_000).toISOString(); // 45s ago

    const row: LockRowSnapshot = {
      id: 'state',
      schemaVersion: 1,
      updatedAt: now,
      lockState: 'apply',
      lockHolder: 'host-99:4242',
      lockRunId: 'run-xyz',
      lockMigrationId: 'mig-golden',
      lockAcquiredAt: acquiredAt,
      heartbeatAt,
    };

    const rendered = renderLockTable(row);

    // All 6 field labels must be present (VALIDATION invariant 9)
    expect(rendered).toContain('lockState');
    expect(rendered).toContain('lockHolder');
    expect(rendered).toContain('lockRunId');
    expect(rendered).toContain('lockMigrationId');
    expect(rendered).toContain('heartbeatAt');
    expect(rendered).toContain('elapsed runtime');

    // Field values must be present
    expect(rendered).toContain('host-99:4242');
    expect(rendered).toContain('run-xyz');
    expect(rendered).toContain('mig-golden');
    expect(rendered).toContain(heartbeatAt);

    // Elapsed time format: Xm Ys
    expect(rendered).toMatch(/\d+m \d+s/);
    // Heartbeat age suffix: Xs ago
    expect(rendered).toMatch(/\d+s ago/);
  });
});

// ---------------------------------------------------------------------------
// runUnlock — interactive confirmation
// ---------------------------------------------------------------------------

describe('runUnlock — interactive confirmation', () => {
  it('UL-08: confirms interactively when --yes is absent (readline mocked to return y)', async () => {
    stubResolveConfig();
    const { client } = makeClient({
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'release' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const mockQuestion = vi.fn().mockResolvedValue('y');
    vi.mocked(createInterface).mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never);

    await runUnlock({ cwd: '/fake', runId: 'run-1' /* no yes */ });

    expect(createInterface).toHaveBeenCalled();
    expect(mockQuestion).toHaveBeenCalled();
    expect(client.forceUnlock).toHaveBeenCalledWith({ runId: 'run-1', yes: true });
  });

  it('UL-09: skips readline interaction when --yes is set', async () => {
    stubResolveConfig();
    const { client } = makeClient({
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'release' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    // readline was NOT called
    expect(createInterface).not.toHaveBeenCalled();
    expect(client.forceUnlock).toHaveBeenCalledWith({ runId: 'run-1', yes: true });
  });

  it('UL-10: aborts when user types n — forceUnlock NOT called, log.info Aborted', async () => {
    stubResolveConfig();
    const { client } = makeClient();
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('n'),
      close: vi.fn(),
    } as never);

    await runUnlock({ cwd: '/fake', runId: 'run-1' });

    expect(client.forceUnlock).not.toHaveBeenCalled();
    expect(stderrChunks.join('')).toContain('Aborted');
  });
});

// ---------------------------------------------------------------------------
// runUnlock — OQ2 / BLOCKER 3 — _migrations.status='failed' patch
// ---------------------------------------------------------------------------

describe('runUnlock — BLOCKER 3 OQ2 patch', () => {
  it('UL-11: warns when priorState is active (apply) — patch called, warn logged', async () => {
    stubResolveConfig();
    const { client, patchFn } = makeClient({
      getLockState: vi.fn().mockResolvedValue(makeActiveLockRow({ lockState: 'apply', lockMigrationId: 'mig-X' })),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'apply' }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('failed');
    expect(stderr).toContain('status patched');
    expect(patchFn).toHaveBeenCalledWith({ id: 'mig-X' });
  });

  it('UL-12: BLOCKER 3 — bundle.migrations.patch called with correct id on priorState=apply', async () => {
    stubResolveConfig();
    const goFn = vi.fn().mockResolvedValue({});
    const setFn = vi.fn().mockReturnValue({ go: goFn });
    const patchFn = vi.fn().mockReturnValue({ set: setFn });

    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(makeActiveLockRow({ lockState: 'apply', lockMigrationId: 'mig-X' })),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'apply' }),
      bundleMigrationsPatch: patchFn,
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    expect(patchFn).toHaveBeenCalledWith({ id: 'mig-X' });
    expect(setFn).toHaveBeenCalledWith({ status: 'failed' });
    expect(goFn).toHaveBeenCalledTimes(1);
  });

  it('UL-13: BLOCKER 3 — patch rejection does NOT propagate; console.error emitted; warn still logged', async () => {
    stubResolveConfig();
    const goFn = vi.fn().mockRejectedValue(new Error('DDB write failed'));
    const setFn = vi.fn().mockReturnValue({ go: goFn });
    const patchFn = vi.fn().mockReturnValue({ set: setFn });

    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(makeActiveLockRow({ lockState: 'apply', lockMigrationId: 'mig-X' })),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'apply' }),
      bundleMigrationsPatch: patchFn,
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should NOT throw even though patch failed
    await expect(runUnlock({ cwd: '/fake', runId: 'run-1', yes: true })).resolves.toBeUndefined();

    // console.error was called with the failure message
    expect(consoleSpy).toHaveBeenCalled();
    const consoleArgs = consoleSpy.mock.calls[0];
    expect(String(consoleArgs[0])).toContain('mig-X');

    // Warning message is still logged to stderr
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('failed');
  });

  it('UL-14: BLOCKER 3 — NO patch when forceUnlock returns priorState=free', async () => {
    stubResolveConfig();
    const patchFn = vi.fn();
    // Note: getLockState returns apply (non-free), but forceUnlock returns free (race)
    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(makeActiveLockRow({ lockState: 'apply', lockMigrationId: 'mig-X' })),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'free' }),
      bundleMigrationsPatch: patchFn,
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    // 'free' is NOT in ACTIVE_PRIOR_STATES — patch should NOT be called
    expect(patchFn).not.toHaveBeenCalled();
  });

  it('UL-15: BLOCKER 3 — NO patch when priorState=release', async () => {
    stubResolveConfig();
    const patchFn = vi.fn();
    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(makeActiveLockRow({ lockState: 'release', lockMigrationId: 'mig-X' })),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'release' }),
      bundleMigrationsPatch: patchFn,
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    // 'release' is NOT in ACTIVE_PRIOR_STATES — patch should NOT be called
    expect(patchFn).not.toHaveBeenCalled();
  });

  it('UL-16: BLOCKER 3 — NO patch when lockMigrationId is undefined', async () => {
    stubResolveConfig();
    const patchFn = vi.fn();
    const { client } = makeClient({
      getLockState: vi.fn().mockResolvedValue(
        makeActiveLockRow({ lockState: 'apply', lockMigrationId: undefined }),
      ),
      forceUnlock: vi.fn().mockResolvedValue({ priorState: 'apply' }),
      bundleMigrationsPatch: patchFn,
    });
    vi.mocked(createMigrationsClient).mockReturnValue(client as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runUnlock({ cwd: '/fake', runId: 'run-1', yes: true });

    // No lockMigrationId → patch should NOT be called
    expect(patchFn).not.toHaveBeenCalled();
  });
});
