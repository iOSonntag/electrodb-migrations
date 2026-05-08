/**
 * `wrapClient` middleware unit tests (GRD-01..07).
 *
 * The middleware is registered on `client.middlewareStack` (NEVER on
 * `command.middlewareStack` — Pitfall #3, [aws-sdk-js-v3#3095]) at
 * `step: 'initialize'` so blocked calls cost zero wire activity.
 *
 * Tests use a fake client whose `middlewareStack.add` captures the
 * middleware function and the registration options. The middleware is then
 * invoked directly with synthesized `(next, context)(rawArgs)` to exercise
 * each branch (free / gating / writes-only / fail-closed) without touching
 * the AWS SDK runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/wrap.js';

type NextHandler = (args: unknown) => Promise<unknown>;
type Middleware = (next: NextHandler, context: { commandName?: string }) => NextHandler;

function makeFakeClient() {
  let capturedMiddleware: Middleware | null = null;
  let capturedOptions: { step?: string; name?: string } | null = null;
  const add = vi.fn((mw: Middleware, opts: { step?: string; name?: string }) => {
    capturedMiddleware = mw;
    capturedOptions = opts;
  });
  const middlewareStack = { add };
  return {
    client: { middlewareStack } as never,
    /** Returns the registered middleware or throws if `wrapClient` did not register one. */
    middleware: (): Middleware => {
      if (capturedMiddleware === null) {
        throw new Error('wrapClient did not register a middleware on the fake client');
      }
      return capturedMiddleware;
    },
    /** Returns the registration options or null if no middleware was registered. */
    options: (): { step?: string; name?: string } | null => capturedOptions,
    addSpy: add,
  };
}

const baseConfig = (over: Partial<ResolvedConfig['guard']> = {}): ResolvedConfig =>
  ({
    entities: ['src/database/entities'],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName: 'test-table',
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 15_000 },
    guard: { cacheTtlMs: 1_000, blockMode: 'all', ...over },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  }) as ResolvedConfig;

/**
 * Build a fake `MigrationsServiceBundle` whose `migrationState.get(...).go(...)`
 * resolves with the supplied lockState. Returns the spyable `get` so tests can
 * assert it was (or wasn't) called.
 */
function makeFakeService(lockState: string, runId?: string) {
  const goCalls: unknown[] = [];
  const get = vi.fn(() => ({
    go: async (opts: unknown) => {
      goCalls.push(opts);
      return {
        data: {
          id: 'state',
          schemaVersion: 1,
          updatedAt: '2026-05-08T00:00:00.000Z',
          lockState,
          ...(runId !== undefined ? { lockRunId: runId } : {}),
        },
      };
    },
  }));
  const service = {
    service: {} as never,
    migrations: {} as never,
    migrationRuns: {} as never,
    migrationState: { get },
  } as never;
  return { service, getSpy: get, goCalls };
}

function makeFailingService(error: Error) {
  const get = vi.fn(() => ({
    go: async () => {
      throw error;
    },
  }));
  const service = {
    service: {} as never,
    migrations: {} as never,
    migrationRuns: {} as never,
    migrationState: { get },
  } as never;
  return { service, getSpy: get };
}

describe('wrapClient middleware (GRD-01..07)', () => {
  it('registers ONE middleware at step "initialize" with the canonical name (Pitfall #3)', () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('free');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    expect(fake.addSpy).toHaveBeenCalledTimes(1);
    expect(fake.options()).toEqual({ step: 'initialize', name: 'electrodb-migrations-guard' });
    expect(fake.middleware()).toBeTypeOf('function');
  });

  it('returns the SAME client instance (mutated in place)', () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('free');
    const result = wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    expect(result).toBe(fake.client);
  });

  it('passes through when lockState is "free" (GRD-04)', async () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('free');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn(async (a: unknown) => ({ output: 'ok', input: a }));
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({ marker: 'in' })).resolves.toEqual({ output: 'ok', input: { marker: 'in' } });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('throws EDBMigrationInProgressError with {runId, lockState} when lockState is in GATING_LOCK_STATES (apply)', async () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('apply', 'r-1');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn();
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({})).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ runId: 'r-1', lockState: 'apply' }),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['rollback', 'r-2'],
    ['release', 'r-3'],
    ['failed', 'r-4'],
    ['dying', 'r-5'],
  ] as const)('throws on lockState=%s (every gating state, Decision A7 set)', async (state, runId) => {
    const fake = makeFakeClient();
    const { service } = makeFakeService(state, runId);
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn();
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({})).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ runId, lockState: state }),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through "finalize" (Decision A7 — README §1 wins; finalize NOT in gating set)', async () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('finalize', 'r-1');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn(async () => ({ output: 'finalize-passes' }));
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({})).resolves.toEqual({ output: 'finalize-passes' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blockMode: "writes-only" lets read commands through WITHOUT invoking the lock-row read (GRD-05)', async () => {
    const fake = makeFakeClient();
    const { service, getSpy } = makeFakeService('apply', 'r-1');
    wrapClient({ client: fake.client, config: baseConfig({ blockMode: 'writes-only' }), internalService: service });
    const next = vi.fn(async () => ({ output: 'read-ok' }));
    const handler = fake.middleware()(next, { commandName: 'GetCommand' });
    await expect(handler({})).resolves.toEqual({ output: 'read-ok' });
    expect(next).toHaveBeenCalledTimes(1);
    // Critical: a read in writes-only mode MUST NOT trigger a lock-row fetch.
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('blockMode: "writes-only" still GATES writes when locked (GRD-05)', async () => {
    const fake = makeFakeClient();
    const { service } = makeFakeService('apply', 'r-1');
    wrapClient({ client: fake.client, config: baseConfig({ blockMode: 'writes-only' }), internalService: service });
    const next = vi.fn();
    const handler = fake.middleware()(next, { commandName: 'PutCommand' });
    await expect(handler({})).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ runId: 'r-1', lockState: 'apply' }),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('blockMode: "all" (default) invokes the lock-row read on read commands too', async () => {
    const fake = makeFakeClient();
    const { service, getSpy } = makeFakeService('apply', 'r-1');
    wrapClient({ client: fake.client, config: baseConfig({ blockMode: 'all' }), internalService: service });
    const next = vi.fn();
    const handler = fake.middleware()(next, { commandName: 'GetCommand' });
    await expect(handler({})).rejects.toMatchObject({ code: 'EDB_MIGRATION_IN_PROGRESS' });
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when readLockRow rejects (GRD-06 / Pitfall #1)', async () => {
    const fake = makeFakeClient();
    const { service } = makeFailingService(new Error('DDB throttle'));
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn();
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({})).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ cause: 'DDB throttle' }),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('reads lock row with consistent: CONSISTENT_READ (GRD-02 — via readLockRow chokepoint)', async () => {
    const fake = makeFakeClient();
    const { service, goCalls } = makeFakeService('free');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn(async () => ({ output: 'ok' }));
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await handler({});
    expect(goCalls.length).toBe(1);
    expect(goCalls[0]).toEqual({ consistent: true });
  });

  it('caches the lock-row read across multiple invocations within TTL (GRD-03 — single fetch for two writes)', async () => {
    const fake = makeFakeClient();
    const { service, getSpy } = makeFakeService('free');
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn(async () => ({ output: 'ok' }));
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await handler({});
    await handler({});
    expect(next).toHaveBeenCalledTimes(2);
    expect(getSpy).toHaveBeenCalledTimes(1); // dedup'd
  });

  it('treats null lock row (no row in DDB) as lockState="free" — passes through', async () => {
    const get = vi.fn(() => ({
      go: async () => ({ data: null }),
    }));
    const service = {
      service: {} as never,
      migrations: {} as never,
      migrationRuns: {} as never,
      migrationState: { get },
    } as never;
    const fake = makeFakeClient();
    wrapClient({ client: fake.client, config: baseConfig(), internalService: service });
    const next = vi.fn(async () => ({ output: 'pass' }));
    const handler = fake.middleware()(next, { commandName: 'PutItemCommand' });
    await expect(handler({})).resolves.toEqual({ output: 'pass' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
