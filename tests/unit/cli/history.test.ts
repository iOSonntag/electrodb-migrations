import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatHistoryJson } from '../../../src/runner/history-format.js';
import { runHistory } from '../../../src/cli/commands/history.js';

// Mock the client factory and config resolver so tests run without DDB.
vi.mock('../../../src/client/index.js', () => ({
  createMigrationsClient: vi.fn(),
}));

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

// Mock createTable so we can inspect what rows are passed.
vi.mock('../../../src/cli/output/table.js', () => ({
  createTable: vi.fn(() => ({ toString: () => 'MOCK_TABLE' })),
}));

async function getCreateMigrationsClientMock() {
  const { createMigrationsClient } = await import('../../../src/client/index.js');
  return vi.mocked(createMigrationsClient);
}

async function getResolveCliConfigMock() {
  const { resolveCliConfig } = await import('../../../src/cli/shared/resolve-config.js');
  return vi.mocked(resolveCliConfig);
}

async function getCreateTableMock() {
  const { createTable } = await import('../../../src/cli/output/table.js');
  return vi.mocked(createTable);
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

function makeHistoryRow(overrides: Partial<ReturnType<typeof baseRow>> = {}) {
  return { ...baseRow(), ...overrides };
}

function baseRow() {
  return {
    id: '20260508-user-add-status',
    schemaVersion: 1 as const,
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

describe('runHistory (CLI-04)', () => {
  it('H-1: empty rows — logs "No migrations recorded." to stderr', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });
    const historyMock = vi.fn().mockResolvedValue([]);
    createMigrationsClient.mockReturnValue({ history: historyMock } as never);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runHistory({ cwd: '/project' });

    const stderrOutput = stderrSpy.mock.calls.map((a) => String(a[0])).join('');
    expect(stderrOutput).toContain('No migrations recorded.');
  });

  it('H-2: with rows, default table — stdout contains the table (column headers verified)', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });
    const historyMock = vi.fn().mockResolvedValue([makeHistoryRow()]);
    createMigrationsClient.mockReturnValue({ history: historyMock } as never);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    const createTable = await getCreateTableMock();

    await runHistory({ cwd: '/project' });

    // createTable was called with appropriate columns.
    expect(createTable).toHaveBeenCalledOnce();
    const callArgs = createTable.mock.calls[0]![0];
    expect(callArgs.head).toContain('id');
    expect(callArgs.head).toContain('entityName');
    expect(callArgs.head).toContain('status');

    // stdout received the table.
    expect(stdoutWrites.join('')).toContain('MOCK_TABLE');
  });

  it('H-3: --json — stdout output is byte-equal to formatHistoryJson(rows)', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });
    const rows = [makeHistoryRow()];
    const historyMock = vi.fn().mockResolvedValue(rows);
    createMigrationsClient.mockReturnValue({ history: historyMock } as never);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runHistory({ cwd: '/project', json: true });

    expect(stdoutWrites).toEqual([formatHistoryJson(rows)]);
  });

  it('H-4: --entity filter applied — client.history called with {entity: "User"}', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });
    const historyMock = vi.fn().mockResolvedValue([]);
    createMigrationsClient.mockReturnValue({ history: historyMock } as never);

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runHistory({ cwd: '/project', entity: 'User' });

    expect(historyMock).toHaveBeenCalledWith({ entity: 'User' });
  });

  it('H-5: sort by id ascending — rows passed to createTable are sorted', async () => {
    const resolveCliConfig = await getResolveCliConfigMock();
    const createMigrationsClient = await getCreateMigrationsClientMock();

    resolveCliConfig.mockResolvedValue({ config: makeResolvedConfig(), configPath: '/project/electrodb-migrations.config.ts', cwd: '/project' });

    // Intentionally unsorted: m2 before m1.
    const rows = [
      makeHistoryRow({ id: '20260508-user-v2', entityName: 'User' }),
      makeHistoryRow({ id: '20260501-user-v1', entityName: 'User' }),
    ];
    const historyMock = vi.fn().mockResolvedValue(rows);
    createMigrationsClient.mockReturnValue({ history: historyMock } as never);

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const createTable = await getCreateTableMock();

    await runHistory({ cwd: '/project' });

    const callArgs = createTable.mock.calls[0]![0];
    // Rows should be sorted by id ascending.
    const ids = callArgs.rows!.map((r: readonly string[]) => r[0]);
    expect(ids).toEqual(['20260501-user-v1', '20260508-user-v2']);
  });
});
