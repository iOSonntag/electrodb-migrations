/**
 * Unit tests for `runApply` (A-1 through A-5).
 *
 * RUN-07: no-pending fast path — exit 0, log.info, no summary.
 * RUN-06: sequence rejection — EDB_NOT_NEXT_PENDING surfaced via log.err, exit 1.
 * RUN-09: success summary written to stderr.
 *
 * Tests A-3 and A-5 simulate the action handler's try/catch pattern
 * (same as the `registerApplyCommand` action's error path) so that
 * process.exit() and log.err() calls can be observed.
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
import { runApply } from '../../../../src/cli/commands/apply.js';

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

function makeClient(overrides: Partial<{
  apply: ReturnType<typeof vi.fn>;
  history: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    apply: overrides.apply ?? vi.fn().mockResolvedValue({ applied: [] }),
    history: overrides.history ?? vi.fn().mockResolvedValue([]),
    release: vi.fn(),
    finalize: vi.fn(),
    status: vi.fn(),
    guardedClient: vi.fn(),
  };
}

/**
 * Simulates the action handler's error-surfacing path:
 *   `catch (err) { log.err(message, remediation); process.exit(USER_ERROR); }`
 */
async function runApplyViaActionHandler(args: Parameters<typeof runApply>[0]): Promise<void> {
  try {
    await runApply(args);
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

describe('runApply (RUN-06/07/09)', () => {
  it('A-1: RUN-07 — no pending; prints info message, no summary written to stderr', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeClient = makeClient({
      apply: vi.fn().mockResolvedValue({ applied: [] }),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(fakeClient as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runApply({ cwd: '/fake' });

    const stderr = stderrChunks.join('');
    // RUN-07: info message written via log.info
    expect(stderr).toContain('No migrations to apply.');
    // No next-steps block (summary not rendered for empty result)
    expect(stderr).not.toContain('Next steps:');
    // history() was NOT called (short-circuit before the join)
    expect(fakeClient.history).not.toHaveBeenCalled();
  });

  it('A-2: single migration success — summary with next-steps written to stderr', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeClient = makeClient({
      apply: vi.fn().mockResolvedValue({
        applied: [{ migId: 'mig-1', itemCounts: { scanned: 100, migrated: 100, skipped: 0, failed: 0 } }],
      }),
      history: vi.fn().mockResolvedValue([
        {
          id: 'mig-1',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          status: 'applied',
        },
      ]),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(fakeClient as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runApply({ cwd: '/fake' });

    const stderr = stderrChunks.join('');
    // Spinner success + summary
    expect(stderr).toContain('Applied 1 migration');
    // RUN-09: next-steps remediation from renderApplySummary
    expect(stderr).toContain('Run `electrodb-migrations release` after deploying the new code');
    // Summary is on stderr (NOT stdout) — verify history was called
    expect(fakeClient.history).toHaveBeenCalledOnce();
  });

  it('A-3: RUN-06 sequence rejection — EDB_NOT_NEXT_PENDING: message+remediation on stderr, exits USER_ERROR', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const seqErr = Object.assign(new Error("Migration 'X' is not the next pending migration for entity Y."), {
      code: 'EDB_NOT_NEXT_PENDING',
      remediation: 'Next pending: A (Y v1→v2)',
    });
    const fakeClient = makeClient({
      apply: vi.fn().mockRejectedValue(seqErr),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(fakeClient as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    // Test through action handler path to verify log.err + process.exit
    await expect(runApplyViaActionHandler({ cwd: '/fake' })).rejects.toThrow('process.exit called');

    const stderr = stderrChunks.join('');
    expect(stderr).toContain("Migration 'X' is not the next pending migration for entity Y.");
    // CLI-09: remediation dim-arrow line
    expect(stderr).toContain('Next pending: A (Y v1→v2)');
    expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
  });

  it('A-4: --migration arg forwarded to client.apply as { migrationId }', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeApply = vi.fn().mockResolvedValue({ applied: [] });
    const fakeClient = makeClient({ apply: fakeApply });
    vi.mocked(createMigrationsClient).mockReturnValue(fakeClient as never);

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runApply({ cwd: '/fake', migrationId: 'mig-1' });

    expect(vi.mocked(createMigrationsClient)).toHaveBeenCalledOnce();
    expect(fakeApply).toHaveBeenCalledWith({ migrationId: 'mig-1' });
  });

  it('A-5: apply failure (generic error) — message on stderr, exits USER_ERROR', async () => {
    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: STUB_CONFIG as never,
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const fakeClient = makeClient({
      apply: vi.fn().mockRejectedValue(new Error('EDB_BATCH_WRITE_EXHAUSTED: retries exhausted')),
    });
    vi.mocked(createMigrationsClient).mockReturnValue(fakeClient as never);

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const mockExit = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });

    // Test through action handler path
    await expect(runApplyViaActionHandler({ cwd: '/fake' })).rejects.toThrow('process.exit called');

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('EDB_BATCH_WRITE_EXHAUSTED');
    expect(mockExit).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
  });
});
