/**
 * Public surface regression test for `src/index.ts` (API-06).
 *
 * PS-1 — existing exports unchanged after this plan
 * PS-2 — NEW: createMigrationsClient + MigrationsClient type exported
 * PS-3 — internal helpers NOT exported from the public surface
 * PS-4 — test that createMigrationsClient is a function (smoke)
 */
import { describe, it, expect } from 'vitest';
import * as publicSurface from '../../src/index.js';

// ---------------------------------------------------------------------------
// PS-1: Existing exports unchanged
// ---------------------------------------------------------------------------

describe('PS-1 — existing exports unchanged', () => {
  it('exports EDBMigrationError', () => {
    expect(publicSurface.EDBMigrationError).toBeDefined();
  });

  it('exports EDBMigrationInProgressError', () => {
    expect(publicSurface.EDBMigrationInProgressError).toBeDefined();
  });

  it('exports EDBMigrationLockHeldError', () => {
    expect(publicSurface.EDBMigrationLockHeldError).toBeDefined();
  });

  it('exports EDBRequiresRollbackError', () => {
    expect(publicSurface.EDBRequiresRollbackError).toBeDefined();
  });

  it('exports EDBRollbackNotPossibleError', () => {
    expect(publicSurface.EDBRollbackNotPossibleError).toBeDefined();
  });

  it('exports EDBRollbackOutOfOrderError', () => {
    expect(publicSurface.EDBRollbackOutOfOrderError).toBeDefined();
  });

  it('exports EDBSelfReadInMigrationError', () => {
    expect(publicSurface.EDBSelfReadInMigrationError).toBeDefined();
  });

  it('exports EDBStaleEntityReadError', () => {
    expect(publicSurface.EDBStaleEntityReadError).toBeDefined();
  });

  it('exports isMigrationInProgress', () => {
    expect(typeof publicSurface.isMigrationInProgress).toBe('function');
  });

  it('exports defineConfig', () => {
    expect(typeof publicSurface.defineConfig).toBe('function');
  });

  it('exports defineMigration', () => {
    expect(typeof publicSurface.defineMigration).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// PS-2: NEW exports added in Plan 04-11
// ---------------------------------------------------------------------------

describe('PS-2 — createMigrationsClient is exported (Plan 04-11)', () => {
  it('exports createMigrationsClient as a function', () => {
    expect(typeof publicSurface.createMigrationsClient).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// PS-3: Internal helpers NOT exported
// ---------------------------------------------------------------------------

describe('PS-3 — internal helpers NOT in public surface', () => {
  it('does not export transitionReleaseToApply', () => {
    expect((publicSurface as Record<string, unknown>)['transitionReleaseToApply']).toBeUndefined();
  });

  it('does not export applyFlow', () => {
    expect((publicSurface as Record<string, unknown>)['applyFlow']).toBeUndefined();
  });

  it('does not export finalizeFlow', () => {
    expect((publicSurface as Record<string, unknown>)['finalizeFlow']).toBeUndefined();
  });

  it('does not export applyBatch', () => {
    expect((publicSurface as Record<string, unknown>)['applyBatch']).toBeUndefined();
  });

  it('does not export loadPendingMigrations', () => {
    expect((publicSurface as Record<string, unknown>)['loadPendingMigrations']).toBeUndefined();
  });

  it('does not export loadMigrationFile', () => {
    expect((publicSurface as Record<string, unknown>)['loadMigrationFile']).toBeUndefined();
  });

  it('does not export createCountAudit', () => {
    expect((publicSurface as Record<string, unknown>)['createCountAudit']).toBeUndefined();
  });

  it('does not export iterateV1Records', () => {
    expect((publicSurface as Record<string, unknown>)['iterateV1Records']).toBeUndefined();
  });

  it('does not export batchFlushV2', () => {
    expect((publicSurface as Record<string, unknown>)['batchFlushV2']).toBeUndefined();
  });

  it('does not export sleep', () => {
    expect((publicSurface as Record<string, unknown>)['sleep']).toBeUndefined();
  });

  it('does not export renderApplySummary', () => {
    expect((publicSurface as Record<string, unknown>)['renderApplySummary']).toBeUndefined();
  });

  it('does not export formatHistoryJson', () => {
    expect((publicSurface as Record<string, unknown>)['formatHistoryJson']).toBeUndefined();
  });

  it('does not export EDBMigrationLoadError', () => {
    expect((publicSurface as Record<string, unknown>)['EDBMigrationLoadError']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PS-4: createMigrationsClient smoke
// ---------------------------------------------------------------------------

describe('PS-4 — createMigrationsClient smoke', () => {
  it('createMigrationsClient is callable and returns an object with apply method', () => {
    const config = {
      entities: ['src/database/entities'],
      migrations: 'src/database/migrations',
      region: undefined,
      tableName: 'smoke-table',
      keyNames: { partitionKey: 'pk', sortKey: 'sk' },
      lock: { heartbeatMs: 5000, staleThresholdMs: 30000, acquireWaitMs: 10000 },
      guard: { cacheTtlMs: 5000, blockMode: 'all' as const },
      remote: undefined,
      migrationStartVersions: {},
      runner: { concurrency: 1 },
    };

    const fakeClient = {
      send: async () => ({}),
      middlewareStack: { add: () => {}, remove: () => {}, use: () => {} },
      config: {},
    } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;

    const client = publicSurface.createMigrationsClient({ config, client: fakeClient });
    expect(typeof client.apply).toBe('function');
    expect(typeof client.finalize).toBe('function');
    expect(typeof client.release).toBe('function');
    expect(typeof client.history).toBe('function');
    expect(typeof client.status).toBe('function');
    expect(typeof client.guardedClient).toBe('function');
  });
});
