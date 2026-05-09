/**
 * Unit tests for createMigrationsClient (API-01, API-02).
 *
 * CMC-1  — factory shape: returns object with EXACTLY the 6 v0.1 methods
 * CMC-2  — tableName resolution (W-01 pinned: plain Error, substring match)
 * CMC-3  — holder defaults to <hostname>:<pid>
 * CMC-4  — apply() dispatches loadPendingMigrations + applyBatch
 * CMC-5  — apply() generates a fresh runId per call
 * CMC-6  — finalize() dispatch (single id + {all:true})
 * CMC-7a..h — release() exhaustive lock-state coverage (W-04)
 * CMC-8  — history() returns typed row array
 * CMC-9  — status() returns lock + recent rows
 * CMC-10 — guardedClient() returns a DynamoDBDocumentClient
 */
import { hostname } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked paths.
// ---------------------------------------------------------------------------

vi.mock('../../../src/runner/index.js', () => ({
  applyBatch: vi.fn(),
  finalizeFlow: vi.fn(),
  loadPendingMigrations: vi.fn(),
  renderApplySummary: vi.fn(() => ''),
  // WR-10: client.history() and client.status() now use the canonical
  // normalizeHistoryRow helper. Provide a faithful stub so the Set→array
  // conversion behaviour the tests pin still works.
  normalizeHistoryRow: (r: { reads?: ReadonlySet<string> | ReadonlyArray<string> }) => {
    const { reads, ...rest } = r;
    const readsArr = reads === undefined ? undefined : [...reads].sort();
    return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) };
  },
}));

vi.mock('../../../src/lock/index.js', () => ({
  readLockRow: vi.fn(),
  acquireLock: vi.fn(),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn(async () => {}) })),
  staleCutoffIso: vi.fn(),
  forceUnlock: vi.fn(),
}));

vi.mock('../../../src/state-mutations/index.js', () => ({
  clear: vi.fn(),
  clearFinalizeMode: vi.fn(),
  acquire: vi.fn(),
  heartbeat: vi.fn(),
  transitionToReleaseMode: vi.fn(),
  markFailed: vi.fn(),
  appendInFlight: vi.fn(),
  unlock: vi.fn(),
  isConditionalCheckFailed: vi.fn(),
  extractCancellationReason: vi.fn(),
}));

vi.mock('../../../src/internal-entities/index.js', () => ({
  createMigrationsService: vi.fn(),
  DEFAULT_TABLE_KEYS: {},
  MIGRATION_STATE_ID: 'state',
  STATE_SCHEMA_VERSION: 1,
  MIGRATIONS_SCHEMA_VERSION: 1,
  MIGRATION_RUNS_SCHEMA_VERSION: 1,
}));

vi.mock('../../../src/guard/index.js', () => ({
  // wrapClient takes WrapClientArgs = { client, config, internalService }
  // and returns the (mutated) client. Our mock returns the client from args.
  wrapClient: vi.fn((wrapArgs: { client: unknown }) => wrapArgs.client),
  createLockStateCache: vi.fn(),
  isReadCommand: vi.fn(),
  GATING_LOCK_STATES: new Set(),
  // runUnguarded: bypass context — in tests, just call fn() directly.
  runUnguarded: vi.fn((fn: () => Promise<unknown>) => fn()),
  getGuardCacheState: vi.fn(() => ({ cacheSize: 0 })),
}));

vi.mock('../../../src/rollback/index.js', () => ({
  rollback: vi.fn(),
  checkPreconditions: vi.fn(),
  determineLifecycleCase: vi.fn(),
  findHeadViolation: vi.fn(),
  classifyOwner: vi.fn(),
  extractDomainKey: vi.fn(),
  classifyTypeTable: vi.fn(),
  executeProjected: vi.fn(),
  executeFillOnly: vi.fn(),
  executeSnapshot: vi.fn(),
  executeCustom: vi.fn(),
  rollbackCase1: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { createMigrationsClient } from '../../../src/client/create-migrations-client.js';
import type { CreateMigrationsClientArgs } from '../../../src/client/types.js';
import * as runnerModule from '../../../src/runner/index.js';
import * as lockModule from '../../../src/lock/index.js';
import * as stateMutationsModule from '../../../src/state-mutations/index.js';
import * as internalEntitiesModule from '../../../src/internal-entities/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake middleware stack with clone() support (required by createMigrationsClient isolation). */
function makeFakeStack() {
  const stack = {
    add: vi.fn(),
    remove: vi.fn(),
    use: vi.fn(),
    clone: vi.fn(),
  };
  // clone() returns a fresh stack with the same shape so the guard isolation path works.
  stack.clone.mockImplementation(() => makeFakeStack());
  return stack;
}

/** Minimal fake DynamoDBDocumentClient — not a real DDB class. */
function makeFakeDocClient() {
  return {
    send: vi.fn(async () => ({})),
    middlewareStack: makeFakeStack(),
    config: {},
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

/** Minimal fake DynamoDBClient (raw, not document). */
function makeFakeRawClient() {
  return {
    send: vi.fn(async () => ({})),
    middlewareStack: makeFakeStack(),
    config: {},
  } as unknown as import('@aws-sdk/client-dynamodb').DynamoDBClient;
}

/** Minimal ResolvedConfig with tableName set. */
function makeConfig(tableName: string | (() => string) | undefined = 'test-table'): import('../../../src/config/index.js').ResolvedConfig {
  return {
    entities: ['src/database/entities'],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName,
    keyNames: {
      partitionKey: 'pk',
      sortKey: 'sk',
    },
    lock: {
      heartbeatMs: 5000,
      staleThresholdMs: 30000,
      acquireWaitMs: 10000,
    },
    guard: {
      cacheTtlMs: 5000,
      blockMode: 'all',
    },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  } as import('../../../src/config/index.js').ResolvedConfig;
}

/** Build a stub MigrationsServiceBundle. */
function makeStubBundle() {
  const migrationsScanGo = vi.fn(async (_opts?: unknown) => ({ data: [] as Record<string, unknown>[] }));
  return {
    service: { transaction: { write: vi.fn() } },
    migrations: {
      scan: { go: migrationsScanGo },
      patch: vi.fn(() => ({ set: vi.fn(() => ({ go: vi.fn(async () => ({})) })) })),
    },
    migrationState: {
      get: vi.fn(() => ({ go: vi.fn(async () => ({ data: null })) })),
    },
    migrationRuns: {},
    _migrationsScanGo: migrationsScanGo,
  };
}

/** Default args for createMigrationsClient with everything wired. */
function makeClientArgs(overrides: Partial<CreateMigrationsClientArgs> = {}): CreateMigrationsClientArgs {
  return {
    config: makeConfig('test-table'),
    client: makeFakeDocClient(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const applyBatch = vi.mocked(runnerModule.applyBatch);
const finalizeFlow = vi.mocked(runnerModule.finalizeFlow);
const loadPendingMigrations = vi.mocked(runnerModule.loadPendingMigrations);
const readLockRow = vi.mocked(lockModule.readLockRow);
const clear = vi.mocked(stateMutationsModule.clear);
const createMigrationsService = vi.mocked(internalEntitiesModule.createMigrationsService);

let stubBundle: ReturnType<typeof makeStubBundle>;

beforeEach(() => {
  vi.clearAllMocks();
  stubBundle = makeStubBundle();
  createMigrationsService.mockReturnValue(stubBundle as unknown as ReturnType<typeof internalEntitiesModule.createMigrationsService>);
  loadPendingMigrations.mockResolvedValue([]);
  applyBatch.mockResolvedValue({ applied: [] });
  finalizeFlow.mockResolvedValue({ itemCounts: { scanned: 0, migrated: 0, deleted: 0, skipped: 0, failed: 0 } });
  readLockRow.mockResolvedValue(null);
  clear.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// CMC-1: Factory shape
// ---------------------------------------------------------------------------

describe('CMC-1 — factory shape', () => {
  it('returns an object with all v0.1 + API-05 methods', () => {
    const client = createMigrationsClient(makeClientArgs());
    expect(typeof client.apply).toBe('function');
    expect(typeof client.finalize).toBe('function');
    expect(typeof client.release).toBe('function');
    expect(typeof client.history).toBe('function');
    expect(typeof client.status).toBe('function');
    expect(typeof client.guardedClient).toBe('function');
    // API-05 methods added in Phase 5
    expect(typeof client.rollback).toBe('function');
    expect(typeof client.forceUnlock).toBe('function');
    expect(typeof client.getLockState).toBe('function');
    expect(typeof client.getGuardState).toBe('function');
    // __bundle is non-enumerable — should NOT appear in Object.keys
    const keys = Object.keys(client).sort();
    expect(keys).toEqual(
      ['apply', 'finalize', 'forceUnlock', 'getLockState', 'getGuardState', 'guardedClient', 'history', 'release', 'rollback', 'status'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// CMC-2: tableName resolution (W-01 pinned)
// ---------------------------------------------------------------------------

describe('CMC-2 — tableName resolution (W-01 pinned)', () => {
  it('uses explicit tableName arg when provided (wins over config)', () => {
    const client = createMigrationsClient(makeClientArgs({ tableName: 'override-table' }));
    expect(client).toBeDefined();
    // service was constructed with 'override-table' (2nd positional arg)
    const firstCall = createMigrationsService.mock.calls[0];
    expect(firstCall?.[1]).toBe('override-table');
  });

  it('uses config.tableName string when no explicit arg', () => {
    const client = createMigrationsClient(makeClientArgs({ config: makeConfig('config-table') }));
    expect(client).toBeDefined();
    const firstCall = createMigrationsService.mock.calls[0];
    expect(firstCall?.[1]).toBe('config-table');
  });

  it('calls config.tableName() thunk and uses result', () => {
    const thunk = vi.fn(() => 'thunk-table');
    const client = createMigrationsClient(makeClientArgs({ config: makeConfig(thunk) }));
    expect(client).toBeDefined();
    expect(thunk).toHaveBeenCalled();
    const firstCall = createMigrationsService.mock.calls[0];
    expect(firstCall?.[1]).toBe('thunk-table');
  });

  it('throws plain Error (not a typed EDB class) with required substrings when tableName is missing', () => {
    // Create a config with no tableName explicitly — cannot use makeConfig(undefined)
    // because that triggers the TypeScript/JS default parameter and sets 'test-table'.
    const configWithoutTableName = {
      ...makeConfig('test-table'),
      tableName: undefined,
    } as import('../../../src/config/index.js').ResolvedConfig;
    const args = makeClientArgs({ config: configWithoutTableName });
    // The factory should throw synchronously (before any DDB calls)
    expect(() => createMigrationsClient(args)).toThrow(
      /createMigrationsClient: tableName is required.*set config\.tableName or pass tableName arg/,
    );
    // MUST be a plain Error, NOT a custom EDB error class
    try {
      createMigrationsClient(args);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      // Must NOT be a typed EDB error (no `code` property that matches EDB pattern)
      expect((err as { code?: string }).code).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CMC-3: holder default
// ---------------------------------------------------------------------------

describe('CMC-3 — holder default', () => {
  it('defaults holder to <hostname>:<pid> when omitted', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await client.apply();
    const callArgs = applyBatch.mock.calls[0]?.[0];
    expect(callArgs?.holder).toBe(`${hostname()}:${process.pid}`);
  });

  it('uses provided holder when set', async () => {
    const client = createMigrationsClient(makeClientArgs({ holder: 'my-worker-01' }));
    await client.apply();
    const callArgs = applyBatch.mock.calls[0]?.[0];
    expect(callArgs?.holder).toBe('my-worker-01');
  });
});

// ---------------------------------------------------------------------------
// CMC-4: apply() method dispatch
// ---------------------------------------------------------------------------

describe('CMC-4 — apply() dispatch', () => {
  it('calls loadPendingMigrations + applyBatch when apply() is called with no args', async () => {
    const pending = [
      { id: 'mig-1', entityName: 'User', fromVersion: '1', toVersion: '2', migration: {} as never, path: '' },
    ];
    loadPendingMigrations.mockResolvedValue(pending);
    applyBatch.mockResolvedValue({ applied: [{ migId: 'mig-1', itemCounts: { scanned: 5, migrated: 5, deleted: 0, skipped: 0, failed: 0 } }] });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.apply();

    expect(loadPendingMigrations).toHaveBeenCalledTimes(1);
    expect(applyBatch).toHaveBeenCalledTimes(1);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.migId).toBe('mig-1');
  });

  it('forwards migrationId to applyBatch when provided', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await client.apply({ migrationId: 'mig-specific' });

    const batchArgs = applyBatch.mock.calls[0]?.[0];
    expect(batchArgs?.migrationId).toBe('mig-specific');
  });

  it('does NOT forward migrationId to applyBatch when not provided', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await client.apply();

    const batchArgs = applyBatch.mock.calls[0]?.[0];
    expect(batchArgs?.migrationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CMC-5: apply() runId freshness
// ---------------------------------------------------------------------------

describe('CMC-5 — apply() runId is fresh per call', () => {
  it('generates a different runId for each apply() call', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await client.apply();
    await client.apply();

    const runId1 = applyBatch.mock.calls[0]?.[0]?.runId;
    const runId2 = applyBatch.mock.calls[1]?.[0]?.runId;
    expect(runId1).toMatch(/^[0-9a-f-]{36}$/);
    expect(runId2).toMatch(/^[0-9a-f-]{36}$/);
    expect(runId1).not.toBe(runId2);
  });
});

// ---------------------------------------------------------------------------
// CMC-6: finalize() dispatch
// ---------------------------------------------------------------------------

describe('CMC-6 — finalize() dispatch', () => {
  it('finds migration by id from loadPendingMigrations and calls finalizeFlow', async () => {
    const fakeMig = { id: 'mig-1', entityName: 'User', fromVersion: '1', toVersion: '2', migration: { id: 'mig-1' } as never, path: '' };
    loadPendingMigrations.mockResolvedValue([fakeMig]);
    finalizeFlow.mockResolvedValue({ itemCounts: { scanned: 10, migrated: 0, deleted: 10, skipped: 0, failed: 0 } });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.finalize('mig-1');

    expect(finalizeFlow).toHaveBeenCalledTimes(1);
    expect(result.finalized).toHaveLength(1);
    expect(result.finalized[0]!.migId).toBe('mig-1');
    expect(result.finalized[0]!.itemCounts.deleted).toBe(10);
  });

  it('throws when migration id not found in pending list', async () => {
    loadPendingMigrations.mockResolvedValue([]);

    const client = createMigrationsClient(makeClientArgs());
    await expect(client.finalize('nonexistent')).rejects.toThrow(/nonexistent/);
  });

  it('{all: true} calls finalizeFlow once per applied migration row', async () => {
    // Stub the migrations.scan.go to return 2 applied rows
    const appliedRows = [
      { id: 'mig-1', status: 'applied' },
      { id: 'mig-2', status: 'applied' },
      { id: 'mig-3', status: 'finalized' }, // should be skipped
    ];
    stubBundle._migrationsScanGo.mockResolvedValue({ data: appliedRows });

    const pending = [
      { id: 'mig-1', entityName: 'User', fromVersion: '1', toVersion: '2', migration: { id: 'mig-1' } as never, path: '' },
      { id: 'mig-2', entityName: 'User', fromVersion: '2', toVersion: '3', migration: { id: 'mig-2' } as never, path: '' },
    ];
    loadPendingMigrations.mockResolvedValue(pending);
    finalizeFlow.mockResolvedValue({ itemCounts: { scanned: 5, migrated: 0, deleted: 5, skipped: 0, failed: 0 } });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.finalize({ all: true });

    // Only the 2 'applied' migrations should have been finalized
    expect(finalizeFlow).toHaveBeenCalledTimes(2);
    expect(result.finalized).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// CMC-7: release() exhaustive lock-state coverage (W-04)
// ---------------------------------------------------------------------------

describe('CMC-7 — release() lock-state coverage (W-04 exhaustive)', () => {
  // CMC-7a
  it('CMC-7a: returns {cleared: false, reason: "no-active-release-lock"} when lock row is null', async () => {
    readLockRow.mockResolvedValue(null);
    const client = createMigrationsClient(makeClientArgs());
    const result = await client.release();
    expect(result).toEqual({ cleared: false, reason: 'no-active-release-lock' });
    expect(clear).not.toHaveBeenCalled();
  });

  // CMC-7b
  it('CMC-7b: returns {cleared: false, reason: "no-active-release-lock"} when lockState is "free"', async () => {
    readLockRow.mockResolvedValue({ id: 'state', schemaVersion: 1, updatedAt: '', lockState: 'free' } as never);
    const client = createMigrationsClient(makeClientArgs());
    const result = await client.release();
    expect(result).toEqual({ cleared: false, reason: 'no-active-release-lock' });
    expect(clear).not.toHaveBeenCalled();
  });

  // CMC-7c
  it('CMC-7c: calls clear and returns {cleared: true} when lockState is "release"', async () => {
    readLockRow.mockResolvedValue({
      id: 'state', schemaVersion: 1, updatedAt: '', lockState: 'release', lockRunId: 'run-abc123',
    } as never);
    const client = createMigrationsClient(makeClientArgs());
    const result = await client.release();
    expect(clear).toHaveBeenCalledWith(stubBundle, { runId: 'run-abc123' });
    expect(result).toEqual({ cleared: true });
  });

  // CMC-7d..h: exhaustive EDB_RELEASE_PREMATURE cases
  it.each([
    ['apply'],
    ['finalize'],
    ['rollback'],
    ['failed'],
    ['dying'],
  ] as const)('%s state → throws EDB_RELEASE_PREMATURE', async ([lockState]) => {
    readLockRow.mockResolvedValue({
      id: 'state', schemaVersion: 1, updatedAt: '', lockState, lockRunId: 'run-xyz',
    } as never);
    const client = createMigrationsClient(makeClientArgs());
    await expect(client.release()).rejects.toMatchObject({
      code: 'EDB_RELEASE_PREMATURE',
    });
    expect(clear).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CMC-8: history()
// ---------------------------------------------------------------------------

describe('CMC-8 — history()', () => {
  it('returns an array of HistoryRow objects', async () => {
    const rows = [
      { id: 'mig-1', status: 'applied', entityName: 'User', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'abc' },
      { id: 'mig-2', status: 'finalized', entityName: 'Post', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'def' },
    ];
    stubBundle._migrationsScanGo.mockResolvedValue({ data: rows });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.history();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('mig-1');
  });

  it('filters by entity when filter.entity is provided', async () => {
    const rows = [
      { id: 'mig-1', status: 'applied', entityName: 'User', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'abc' },
      { id: 'mig-2', status: 'finalized', entityName: 'Post', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'def' },
    ];
    stubBundle._migrationsScanGo.mockResolvedValue({ data: rows });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.history({ entity: 'User' });

    expect(result).toHaveLength(1);
    expect(result[0]!.entityName).toBe('User');
  });

  it('converts reads Set to sorted array', async () => {
    const rows = [
      { id: 'mig-1', status: 'applied', entityName: 'User', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'abc', reads: new Set(['b', 'a', 'c']) },
    ];
    stubBundle._migrationsScanGo.mockResolvedValue({ data: rows });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.history();

    expect(result[0]!.reads).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// CMC-9: status()
// ---------------------------------------------------------------------------

describe('CMC-9 — status()', () => {
  it('returns {lock, recent} from readLockRow + migrations scan', async () => {
    const lockRow = { id: 'state', schemaVersion: 1, updatedAt: '2026-01-01', lockState: 'free' };
    readLockRow.mockResolvedValue(lockRow as never);

    const rows = [
      { id: 'mig-1', status: 'applied', entityName: 'User', schemaVersion: 1, kind: 'transform', fromVersion: '1', toVersion: '2', fingerprint: 'abc' },
    ];
    stubBundle._migrationsScanGo.mockResolvedValue({ data: rows });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.status();

    expect(result.lock).toEqual(lockRow);
    expect(Array.isArray(result.recent)).toBe(true);
    expect(result.recent).toHaveLength(1);
  });

  it('returns {lock: null, recent: []} when no lock row and no migrations', async () => {
    readLockRow.mockResolvedValue(null);
    stubBundle._migrationsScanGo.mockResolvedValue({ data: [] });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.status();

    expect(result.lock).toBeNull();
    expect(result.recent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CMC-10: guardedClient()
// ---------------------------------------------------------------------------

describe('CMC-10 — guardedClient()', () => {
  it('returns a DynamoDBDocumentClient-like object (the guarded client)', () => {
    const docClient = makeFakeDocClient();
    const client = createMigrationsClient(makeClientArgs({ client: docClient }));
    const guarded = client.guardedClient();
    // wrapClient returns the client itself (mutated in place) — our mock returns it as-is
    expect(guarded).toBeDefined();
    expect(typeof guarded.send).toBe('function');
  });

  it('returns the same guarded client on repeated calls', () => {
    const client = createMigrationsClient(makeClientArgs());
    const g1 = client.guardedClient();
    const g2 = client.guardedClient();
    expect(g1).toBe(g2);
  });
});
