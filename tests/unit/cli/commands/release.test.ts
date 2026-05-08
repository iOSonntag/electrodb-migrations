/**
 * Unit tests for `runRelease` (R-1 through R-4).
 *
 * REL-01: cleared path — lock cleared, spinner success.
 * REL-02: idempotent no-op — no active release-mode lock, log.info, no exit.
 * EDB_RELEASE_PREMATURE: premature release — log.err + process.exit(USER_ERROR).
 * Generic failure: log.err (no remediation), process.exit(USER_ERROR).
 *
 * Tests R-3 and R-4 simulate the action handler's try/catch pattern
 * (same as `registerReleaseCommand` action's error path).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../src/client/index.js', () => ({
  createMigrationsClient: vi.fn(),
}));

vi.mock('../../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { createMigrationsClient } from '../../../../src/client/index.js';
import { resolveCliConfig } from '../../../../src/cli/shared/resolve-config.js';
import { EXIT_CODES } from '../../../../src/cli/output/exit-codes.js';
import { log } from '../../../../src/cli/output/log.js';
import { runRelease } from '../../../../src/cli/commands/release.js';

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

function makeClient(releaseImpl: ReturnType<typeof vi.fn>) {
  return {
    apply: vi.fn(),
    history: vi.fn(),
    release: releaseImpl,
    finalize: vi.fn(),
    status: vi.fn(),
    guardedClient: vi.fn(),
  };
}

/**
 * Simulates the action handler's error-surfacing path:
 *   `catch (err) { log.err(message, remediation); process.exit(USER_ERROR); }`
 */
async function runReleaseViaActionHandler(args: Parameters<typeof runRelease>[0]): Promise<void> {
  try {
    await runRelease(args);
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

describe('runRelease (REL-01/02)', () => {
  it('R-1: cleared — spinner success written to stderr, no throw', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeRelease = vi.fn().mockResolvedValue({ cleared: true });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRelease) as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runRelease({ cwd: '/fake' });

    const stderr = stderrChunks.join('');
    // Spinner success message
    expect(stderr).toContain('Release-mode lock cleared.');
    // No error
    expect(stderr).not.toContain('✘');
  });

  it('R-2: REL-02 idempotent no-op — info message on stderr, process.exit NOT called', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeRelease = vi.fn().mockResolvedValue({ cleared: false, reason: 'no-active-release-lock' });
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRelease) as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const mockExit = vi.spyOn(process, 'exit');

    await runRelease({ cwd: '/fake' });

    const stderr = stderrChunks.join('');
    // REL-02: info (not error) message
    expect(stderr).toContain('No active release-mode lock — nothing to do.');
    // Process does NOT exit on idempotent no-op
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('R-3: EDB_RELEASE_PREMATURE — message+remediation on stderr, exits USER_ERROR', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const prematureErr = Object.assign(new Error("release refused — lock is in 'apply' state, not 'release'."), {
      code: 'EDB_RELEASE_PREMATURE',
      remediation: 'Wait for the active operation to complete...',
    });
    const fakeRelease = vi.fn().mockRejectedValue(prematureErr);
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRelease) as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    await expect(runReleaseViaActionHandler({ cwd: '/fake' })).rejects.toThrow('process.exit called');

    const stderr = stderrChunks.join('');
    // Error message
    expect(stderr).toContain("release refused — lock is in 'apply' state, not 'release'.");
    // CLI-09: remediation dim-arrow line
    expect(stderr).toContain('Wait for the active operation to complete...');
    expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
  });

  it('R-4: generic failure (no remediation) — message on stderr, exits USER_ERROR', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeRelease = vi.fn().mockRejectedValue(new Error('network down'));
    vi.mocked(createMigrationsClient).mockReturnValue(makeClient(fakeRelease) as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    await expect(runReleaseViaActionHandler({ cwd: '/fake' })).rejects.toThrow('process.exit called');

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('network down');
    expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
  });
});
