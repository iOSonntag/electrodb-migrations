/**
 * Unit tests for `loadMigrationFile` (LM-*) and `loadPendingMigrations` /
 * `isNextPending` (LP-* / NP-*).
 *
 * RUN-06: per-entity sequence enforcement (isNextPending).
 * RUN-07: no-pending exits with empty array (LP-1).
 *
 * LM tests use real jiti loading against fixture files (`vi.importActual`).
 * LP tests mock `node:fs/promises` readdir + `loadMigrationFile` for
 * deterministic I/O.
 * NP tests are pure logic — no I/O.
 */

import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingMigration } from '../../../src/runner/load-pending.js';
import { isNextPending, loadPendingMigrations } from '../../../src/runner/load-pending.js';
import { EDBMigrationLoadError, loadMigrationFile } from '../../../src/runner/load-migration-module.js';
import { makeRunnerStubService } from './_stub-service.js';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

// Mock node:fs/promises so readdir returns controlled values per-test.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readdir: vi.fn(),
  };
});

// Mock loadMigrationFile so LP tests don't touch real jiti / disk.
// LM tests use vi.importActual to get the real implementation.
vi.mock('../../../src/runner/load-migration-module.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/runner/load-migration-module.js')>();
  return {
    ...original,
    loadMigrationFile: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_BASE = join(import.meta.dirname, '../../_helpers/sample-migrations');

/** Minimal ResolvedConfig stub — only the fields loadPendingMigrations uses. */
function makeConfig(migrationsDir: string) {
  return {
    migrations: migrationsDir,
    entities: [],
    region: undefined,
    tableName: undefined,
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    lock: { heartbeatMs: 5000, staleThresholdMs: 15000, acquireWaitMs: 30000 },
    guard: { cacheTtlMs: 1000, blockMode: 'all' as const },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  };
}

/** Minimal PendingMigration for NP tests (no real migration object needed). */
function makePending(id: string, entityName: string, fromVersion: string): PendingMigration {
  return {
    id,
    entityName,
    fromVersion,
    toVersion: String(Number(fromVersion) + 1),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    migration: {} as any,
    path: `/fake/${id}/migration.ts`,
  };
}

/** Minimal migration object returned by the mock loadMigrationFile. */
function makeMigObj(id: string, entityName: string, fromVersion: string, toVersion: string) {
  return {
    id,
    entityName,
    from: { model: { version: fromVersion } },
    to: { model: { version: toVersion } },
    up: async (r: unknown) => r,
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;
}

// ---------------------------------------------------------------------------
// LM: loadMigrationFile tests (real jiti, importActual)
// ---------------------------------------------------------------------------

describe('loadMigrationFile', () => {
  it('LM-1: loads real User-add-status/v1.ts and returns module namespace (no default export)', async () => {
    const { loadMigrationFile: realLoader } = await vi.importActual<
      typeof import('../../../src/runner/load-migration-module.js')
    >('../../../src/runner/load-migration-module.js');

    // v1.ts has no default export — loader returns the module namespace.
    const path = join(FIXTURES_BASE, 'User-add-status', 'v1.ts');
    const mod = await realLoader(path);
    expect(mod).toBeDefined();
    const ns = mod as unknown as Record<string, unknown>;
    // Module namespace contains createUserV1 factory
    expect(typeof ns['createUserV1']).toBe('function');
  }, 30_000);

  it('LM-2: falls back to module namespace when no default export', async () => {
    const { loadMigrationFile: realLoader } = await vi.importActual<
      typeof import('../../../src/runner/load-migration-module.js')
    >('../../../src/runner/load-migration-module.js');

    // User-add-tier/v2.ts has no default export either.
    const path = join(FIXTURES_BASE, 'User-add-tier', 'v2.ts');
    const mod = await realLoader(path);
    const ns = mod as unknown as Record<string, unknown>;
    expect(typeof ns['createUserV3']).toBe('function');
  }, 30_000);

  it('LM-3: wraps inner errors in EDBMigrationLoadError with correct code + details', async () => {
    const { loadMigrationFile: realLoader } = await vi.importActual<
      typeof import('../../../src/runner/load-migration-module.js')
    >('../../../src/runner/load-migration-module.js');

    const fakePath = '/absolutely-nonexistent/path/migration.ts';
    let caught: unknown;
    try {
      await realLoader(fakePath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EDBMigrationLoadError);
    const edbErr = caught as EDBMigrationLoadError;
    expect(edbErr.code).toBe('EDB_MIGRATION_LOAD_ERROR');
    expect(edbErr.details['path']).toBe(fakePath);
    expect(edbErr.details['cause']).toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// LP: loadPendingMigrations tests
// ---------------------------------------------------------------------------

describe('loadPendingMigrations', () => {
  const { service, setScanPages, scanGoSpy } = makeRunnerStubService();

  beforeEach(async () => {
    vi.mocked(loadMigrationFile).mockReset();
    scanGoSpy.mockClear();
    // Default scan: return empty data (no _migrations rows).
    setScanPages([]);
    // Reset readdir mock so each test starts with a fresh state.
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockReset();
  });

  it('LP-1: empty migrations directory → returns [] without calling scan', async () => {
    // Simulate readdir throwing (directory not found).
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockRejectedValue(new Error('ENOENT: directory not found'));

    const config = makeConfig('/does-not-exist-empty-dir');
    const result = await loadPendingMigrations({ config, service, cwd: '/' });

    expect(result).toEqual([]);
    // scan.go should NOT have been called (short-circuits before scan on empty dir).
    expect(scanGoSpy).not.toHaveBeenCalled();
  });

  it('LP-2: two disk migrations, zero _migrations rows → both pending sorted by (entityName, fromVersion)', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['User-add-status', 'User-add-tier'] as unknown as Awaited<ReturnType<typeof readdir>>);

    vi.mocked(loadMigrationFile)
      .mockResolvedValueOnce(makeMigObj('20260601000000-User-add-status', 'User', '1', '2'))
      .mockResolvedValueOnce(makeMigObj('20260701000000-User-add-tier', 'User', '2', '3'));

    setScanPages([]);

    const config = makeConfig('migrations');
    const result = await loadPendingMigrations({ config, service, cwd: '/fake' });

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('20260601000000-User-add-status');
    expect(result[0]!.fromVersion).toBe('1');
    expect(result[1]!.id).toBe('20260701000000-User-add-tier');
    expect(result[1]!.fromVersion).toBe('2');
  });

  it('LP-3: applied _migrations row for User-add-status → only User-add-tier pending', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['User-add-status', 'User-add-tier'] as unknown as Awaited<ReturnType<typeof readdir>>);

    vi.mocked(loadMigrationFile)
      .mockResolvedValueOnce(makeMigObj('20260601000000-User-add-status', 'User', '1', '2'))
      .mockResolvedValueOnce(makeMigObj('20260701000000-User-add-tier', 'User', '2', '3'));

    setScanPages([
      { id: '20260601000000-User-add-status', status: 'applied', entityName: 'User', fromVersion: '1', toVersion: '2' },
    ]);

    const config = makeConfig('migrations');
    const result = await loadPendingMigrations({ config, service, cwd: '/fake' });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('20260701000000-User-add-tier');
  });

  it('LP-4: 4 cross-entity migrations, 0 rows → sorted by (entityName, fromVersion) ascending', async () => {
    const { readdir } = await import('node:fs/promises');
    // Directory order is intentionally mixed to verify sort correctness.
    vi.mocked(readdir).mockResolvedValue(['User-v1', 'User-v2', 'Team-v1', 'Team-v2'] as unknown as Awaited<ReturnType<typeof readdir>>);

    vi.mocked(loadMigrationFile)
      .mockResolvedValueOnce(makeMigObj('User-v1', 'User', '1', '2'))
      .mockResolvedValueOnce(makeMigObj('User-v2', 'User', '2', '3'))
      .mockResolvedValueOnce(makeMigObj('Team-v1', 'Team', '1', '2'))
      .mockResolvedValueOnce(makeMigObj('Team-v2', 'Team', '2', '3'));

    setScanPages([]);

    const config = makeConfig('migrations');
    const result = await loadPendingMigrations({ config, service, cwd: '/fake' });

    expect(result).toHaveLength(4);
    // Sort: Team < User (alphabetic); within entity by numeric fromVersion ascending.
    expect(result[0]!.entityName).toBe('Team');
    expect(result[0]!.fromVersion).toBe('1');
    expect(result[1]!.entityName).toBe('Team');
    expect(result[1]!.fromVersion).toBe('2');
    expect(result[2]!.entityName).toBe('User');
    expect(result[2]!.fromVersion).toBe('1');
    expect(result[3]!.entityName).toBe('User');
    expect(result[3]!.fromVersion).toBe('2');
  });

  it('LP-5: failed migration row is NOT pending (requires rollback first)', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['User-add-status'] as unknown as Awaited<ReturnType<typeof readdir>>);

    vi.mocked(loadMigrationFile).mockResolvedValueOnce(
      makeMigObj('20260601000000-User-add-status', 'User', '1', '2'),
    );

    setScanPages([
      { id: '20260601000000-User-add-status', status: 'failed', entityName: 'User', fromVersion: '1', toVersion: '2' },
    ]);

    const config = makeConfig('migrations');
    const result = await loadPendingMigrations({ config, service, cwd: '/fake' });

    // failed status is NOT pending — operator must run rollback first (RUN-06 disposition).
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NP: isNextPending tests (pure logic, no I/O)
// ---------------------------------------------------------------------------

describe('isNextPending', () => {
  it('NP-1: empty pending list → false', () => {
    expect(isNextPending([], '20260601000000-User-add-status')).toBe(false);
  });

  it('NP-2: migId is the first pending of its entity → true', () => {
    const pending = [
      makePending('20260601000000-User-add-status', 'User', '1'),
      makePending('20260701000000-User-add-tier', 'User', '2'),
    ];
    expect(isNextPending(pending, '20260601000000-User-add-status')).toBe(true);
  });

  it('NP-3: migId is NOT first of its entity (another is ahead) → false', () => {
    const pending = [
      makePending('20260601000000-User-add-status', 'User', '1'),
      makePending('20260701000000-User-add-tier', 'User', '2'),
    ];
    expect(isNextPending(pending, '20260701000000-User-add-tier')).toBe(false);
  });

  it('NP-4: per-entity scope — migId is next FOR ITS ENTITY even if another entity is earlier in global list', () => {
    // Global order (cross-entity sorted): Team-v1, User-add-status.
    // Per-entity check: User-add-status IS the first pending User — true.
    // Per-entity check: Team-v1 IS the first pending Team — true.
    const pending = [
      makePending('Team-v1', 'Team', '1'),
      makePending('20260601000000-User-add-status', 'User', '1'),
    ];
    expect(isNextPending(pending, '20260601000000-User-add-status')).toBe(true);
    expect(isNextPending(pending, 'Team-v1')).toBe(true);
  });
});
