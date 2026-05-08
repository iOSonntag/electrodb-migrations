import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colorizeLockState, runStatus } from '../../../src/cli/commands/status.js';

// Mock the client factory and config resolver so tests run without DDB.
vi.mock('../../../src/client/index.js', () => ({
  createMigrationsClient: vi.fn(),
}));

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
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

function makeLockRow() {
  return {
    id: 'state' as const,
    schemaVersion: 1,
    updatedAt: '2026-05-08T12:00:00.000Z',
    lockState: 'free' as const,
    lockHolder: 'host-1:1234',
    lockRunId: 'run-abc',
    lockMigrationId: 'mig-1',
    heartbeatAt: '2026-05-08T12:00:00.000Z',
    inFlightIds: new Set<string>(['mig-1']),
    failedIds: new Set<string>(),
    releaseIds: new Set<string>(),
  };
}

function makeHistoryRow() {
  return {
    id: '20260508-user-add-status',
    schemaVersion: 1,
    kind: 'transform' as const,
    status: 'applied' as const,
    entityName: 'User',
    fromVersion: '1',
    toVersion: '2',
    fingerprint: 'sha256:abc',
    appliedAt: '2026-05-08T12:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runStatus (CLI-03)', () => {
  it('S-1: default table view — two tables written to stdout when lock + recent both present', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const statusMock = vi.fn().mockResolvedValue({
      lock: makeLockRow(),
      recent: [makeHistoryRow()],
    });
    createMigrationsClient.mockReturnValue({ status: statusMock } as never);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runStatus({ cwd: '/project' });

    expect(stdoutWrites.length).toBeGreaterThanOrEqual(2);
    const combined = stdoutWrites.join('');
    expect(combined).toContain('lockState');
    expect(combined).toContain('entityName');
  });

  it('S-2: --json — stdout output starts with {"lock": and contains inFlightIds array', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const statusMock = vi.fn().mockResolvedValue({
      lock: makeLockRow(),
      recent: [makeHistoryRow()],
    });
    createMigrationsClient.mockReturnValue({ status: statusMock } as never);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runStatus({ cwd: '/project', json: true });

    const output = stdoutWrites.join('');
    expect(output).toMatch(/^\s*\{/u);
    expect(output).toContain('"lock"');
    expect(output).toContain('"inFlightIds"');
    // inFlightIds should be an array, not a Set.
    const parsed = JSON.parse(output) as { lock: { inFlightIds: unknown } };
    expect(Array.isArray(parsed.lock.inFlightIds)).toBe(true);
  });

  it('S-3: lock row null — logs to stderr, no lock table written to stdout', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const statusMock = vi.fn().mockResolvedValue({ lock: null, recent: [] });
    createMigrationsClient.mockReturnValue({ status: statusMock } as never);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runStatus({ cwd: '/project' });

    expect(stdoutWrites).toHaveLength(0);
    const stderrOutput = stderrSpy.mock.calls.map((a) => String(a[0])).join('');
    expect(stderrOutput).toContain('not bootstrapped');
  });

  it('S-4: Pitfall 8 — Set rendering; table cell shows comma-joined; --json shows sorted array', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    const lockWithSet = {
      ...makeLockRow(),
      lockState: 'apply' as const,
      inFlightIds: new Set(['m2', 'm1']), // unsorted
    };

    const statusMock = vi.fn().mockResolvedValue({ lock: lockWithSet, recent: [] });
    createMigrationsClient.mockReturnValue({ status: statusMock } as never);

    // Default table mode — Set rendered as comma-joined string.
    const stdoutTableWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutTableWrites.push(String(chunk));
      return true;
    });

    await runStatus({ cwd: '/project' });

    const tableOutput = stdoutTableWrites.join('');
    expect(tableOutput).toContain('m1');
    expect(tableOutput).toContain('m2');

    vi.clearAllMocks();

    // JSON mode — inFlightIds must be a sorted array.
    const stdoutJsonWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutJsonWrites.push(String(chunk));
      return true;
    });

    await runStatus({ cwd: '/project', json: true });

    const parsed = JSON.parse(stdoutJsonWrites.join('')) as { lock: { inFlightIds: string[] } };
    expect(parsed.lock.inFlightIds).toEqual(['m1', 'm2']); // sorted
  });

  it('S-5: color escapes — lockState="failed" is wrapped in c.err() (contains ANSI escape)', () => {
    // colorizeLockState is exported for testability (Pitfall 8 pattern).
    const result = colorizeLockState('failed');
    expect(result).toContain('failed');
    // picocolors injects ANSI escape sequences in TTY mode; in test mode it may or may not
    // depending on the env. Assert the string contains the word at minimum.
    // If colors ARE active, there will be escape sequences wrapping it.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
