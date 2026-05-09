/**
 * API-05 — MigrationsClient surface shape tests.
 *
 * Verifies:
 * 1. The 4 new API-05 methods exist as functions on the returned client object.
 * 2. The __bundle non-enumerable property is present with correct descriptor.
 * 3. BLOCKER 2: client.forceUnlock() rejects with EDBUnlockRequiresConfirmationError
 *    when `yes` is omitted or `yes: false`.
 * 4. BLOCKER 2 proceed path: client.forceUnlock({yes: true}) calls the lib function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports from the mocked paths.
// ---------------------------------------------------------------------------

vi.mock('../../../src/runner/index.js', () => ({
  applyBatch: vi.fn(),
  finalizeFlow: vi.fn(),
  loadPendingMigrations: vi.fn(),
  renderApplySummary: vi.fn(() => ''),
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
  forceUnlock: vi.fn(async () => ({ priorState: 'apply' })),
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
  wrapClient: vi.fn((wrapArgs: { client: unknown }) => wrapArgs.client),
  createLockStateCache: vi.fn(),
  isReadCommand: vi.fn(),
  GATING_LOCK_STATES: new Set(),
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
import * as lockModule from '../../../src/lock/index.js';
import * as internalEntitiesModule from '../../../src/internal-entities/index.js';
import { EDBUnlockRequiresConfirmationError } from '../../../src/errors/index.js';

// ---------------------------------------------------------------------------
// Helpers (mirrored from create-migrations-client.test.ts)
// ---------------------------------------------------------------------------

function makeFakeStack() {
  const stack = {
    add: vi.fn(),
    remove: vi.fn(),
    use: vi.fn(),
    clone: vi.fn(),
  };
  stack.clone.mockImplementation(() => makeFakeStack());
  return stack;
}

function makeFakeDocClient() {
  return {
    send: vi.fn(async () => ({})),
    middlewareStack: makeFakeStack(),
    config: {},
  } as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
}

function makeConfig(tableName = 'test-table'): import('../../../src/config/index.js').ResolvedConfig {
  return {
    entities: ['src/database/entities'],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName,
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    lock: { heartbeatMs: 5000, staleThresholdMs: 30000, acquireWaitMs: 10000 },
    guard: { cacheTtlMs: 5000, blockMode: 'all' },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  } as import('../../../src/config/index.js').ResolvedConfig;
}

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

function makeClientArgs(overrides: Partial<CreateMigrationsClientArgs> = {}): CreateMigrationsClientArgs {
  return {
    config: makeConfig('test-table'),
    client: makeFakeDocClient(),
    ...overrides,
  };
}

const createMigrationsService = vi.mocked(internalEntitiesModule.createMigrationsService);
const forceUnlockLib = vi.mocked(lockModule.forceUnlock);

let stubBundle: ReturnType<typeof makeStubBundle>;

beforeEach(() => {
  vi.clearAllMocks();
  stubBundle = makeStubBundle();
  createMigrationsService.mockReturnValue(
    stubBundle as unknown as ReturnType<typeof internalEntitiesModule.createMigrationsService>,
  );
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('API-05 — MigrationsClient surface', () => {
  // -------------------------------------------------------------------------
  // Case 1: 4 new methods exist as functions on the client object
  // -------------------------------------------------------------------------
  it('exposes rollback, forceUnlock, getLockState, getGuardState methods', () => {
    const client = createMigrationsClient(makeClientArgs());

    expect(typeof client.rollback).toBe('function');
    expect(typeof client.forceUnlock).toBe('function');
    expect(typeof client.getLockState).toBe('function');
    expect(typeof client.getGuardState).toBe('function');

    // Pre-existing methods still present (regression check)
    expect(typeof client.apply).toBe('function');
    expect(typeof client.finalize).toBe('function');
    expect(typeof client.release).toBe('function');
    expect(typeof client.history).toBe('function');
    expect(typeof client.status).toBe('function');
    expect(typeof client.guardedClient).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Case 1b: __bundle non-enumerable property (REG-IT2-01)
  // -------------------------------------------------------------------------
  it('client object exposes a non-enumerable __bundle property strict-equal to the bundle passed to createMigrationsClient', () => {
    const client = createMigrationsClient(makeClientArgs());

    const desc = Object.getOwnPropertyDescriptor(client, '__bundle');
    expect(desc).toBeDefined();
    expect(desc!.enumerable).toBe(false);
    expect(desc!.writable).toBe(false);
    expect(desc!.configurable).toBe(false);

    // Identity check: the accessor exposes the same bundle reference used internally.
    expect((client as unknown as { __bundle: unknown }).__bundle).toBe(stubBundle);

    // Spread / Object.keys must NOT include __bundle
    expect(Object.keys(client)).not.toContain('__bundle');
    expect(Object.keys({ ...client })).not.toContain('__bundle');
  });

  // -------------------------------------------------------------------------
  // Case 2: BLOCKER 2 — forceUnlock rejects when yes is omitted
  // -------------------------------------------------------------------------
  it('client.forceUnlock rejects with EDBUnlockRequiresConfirmationError when yes is omitted', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await expect(client.forceUnlock({ runId: 'any' })).rejects.toBeInstanceOf(
      EDBUnlockRequiresConfirmationError,
    );
  });

  // -------------------------------------------------------------------------
  // Case 3: BLOCKER 2 — forceUnlock rejects when yes is false
  // -------------------------------------------------------------------------
  it('client.forceUnlock rejects with EDBUnlockRequiresConfirmationError when yes is false', async () => {
    const client = createMigrationsClient(makeClientArgs());
    await expect(client.forceUnlock({ runId: 'any', yes: false })).rejects.toBeInstanceOf(
      EDBUnlockRequiresConfirmationError,
    );
  });

  // -------------------------------------------------------------------------
  // Case 4: BLOCKER 2 proceed path — forceUnlock with yes: true calls lib
  // -------------------------------------------------------------------------
  it('client.forceUnlock with yes: true proceeds to the lib call', async () => {
    forceUnlockLib.mockResolvedValue({ priorState: 'apply' });

    const client = createMigrationsClient(makeClientArgs());
    const result = await client.forceUnlock({ runId: 'test-run-id', yes: true });

    // The lib should have been called once with the runId
    expect(forceUnlockLib).toHaveBeenCalledTimes(1);
    expect(forceUnlockLib).toHaveBeenCalledWith(
      expect.anything(), // bundle
      { runId: 'test-run-id' },
    );

    // Result passes through from the lib
    expect(result.priorState).toBe('apply');
  });
});
