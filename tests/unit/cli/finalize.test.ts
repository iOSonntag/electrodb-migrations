import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFinalize } from '../../../src/cli/commands/finalize.js';

// Mock the client factory and config resolver so tests run without DDB.
vi.mock('../../../src/client/index.js', () => ({
  createMigrationsClient: vi.fn(),
}));

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

// Silence spinner output (yocto-spinner writes to stderr).
vi.mock('../../../src/cli/output/spinner.js', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    setText: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    stop: vi.fn(),
  })),
}));

async function getCreateMigrationsClientMock() {
  const { createMigrationsClient } = await import('../../../src/client/index.js');
  return vi.mocked(createMigrationsClient);
}

async function getResolveCliConfigMock() {
  const { resolveCliConfig } = await import('../../../src/cli/shared/resolve-config.js');
  return vi.mocked(resolveCliConfig);
}

function makeResolvedConfig() {
  return {
    entities: ['src/database/entities'],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName: 'test-table',
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    lock: { heartbeatMs: 5000, staleThresholdMs: 30000, acquireWaitMs: 2000 },
    guard: { cacheTtlMs: 1000, blockMode: 'all' as const },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runFinalize (FIN-01/02/03/04)', () => {
  it('F-1: <id> provided — calls client.finalize with the migration id string', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const finalizeMock = vi.fn().mockResolvedValue({
      finalized: [{ migId: 'mig-1', itemCounts: { scanned: 100, migrated: 0, deleted: 100, skipped: 0, failed: 0 } }],
    });
    createMigrationsClient.mockReturnValue({ finalize: finalizeMock } as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runFinalize({ cwd: '/project', migrationId: 'mig-1' });

    expect(finalizeMock).toHaveBeenCalledWith('mig-1');
    const stderrOutput = stderrSpy.mock.calls.map((a) => String(a[0])).join('');
    // Should mention scanned and deleted counts.
    expect(stderrOutput).toContain('100 scanned');
    expect(stderrOutput).toContain('100 deleted');
  });

  it('F-2: --all — calls client.finalize with {all: true}; logs two bullet lines', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const finalizeMock = vi.fn().mockResolvedValue({
      finalized: [
        { migId: 'm1', itemCounts: { scanned: 50, migrated: 0, deleted: 50, skipped: 0, failed: 0 } },
        { migId: 'm2', itemCounts: { scanned: 80, migrated: 0, deleted: 75, skipped: 5, failed: 0 } },
      ],
    });
    createMigrationsClient.mockReturnValue({ finalize: finalizeMock } as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runFinalize({ cwd: '/project', all: true });

    expect(finalizeMock).toHaveBeenCalledWith({ all: true });
    const stderrOutput = stderrSpy.mock.calls.map((a) => String(a[0])).join('');
    expect(stderrOutput).toContain('m1');
    expect(stderrOutput).toContain('m2');
  });

  it('F-3: neither id nor --all — throws with remediation mentioning "either <id> or --all"', async () => {
    let caught: unknown;
    try {
      await runFinalize({ cwd: '/project' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/finalize requires either/);
    // Remediation should guide the user to provide either <id> or --all.
    expect((caught as { remediation?: string }).remediation).toMatch(/<id>|--all/u);
  });

  it('F-4: both id AND --all — throws with remediation mentioning "mutually exclusive"', async () => {
    let caught: unknown;
    try {
      await runFinalize({ cwd: '/project', migrationId: 'mig-1', all: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/mutually exclusive/);
    expect((caught as { remediation?: string }).remediation).toContain('specific id OR --all');
  });

  it('F-5: --all with zero applied migrations — stops spinner and logs "No applied migrations to finalize."', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const finalizeMock = vi.fn().mockResolvedValue({ finalized: [] });
    createMigrationsClient.mockReturnValue({ finalize: finalizeMock } as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runFinalize({ cwd: '/project', all: true });

    const stderrOutput = stderrSpy.mock.calls.map((a) => String(a[0])).join('');
    expect(stderrOutput).toContain('No applied migrations to finalize.');
  });
});
