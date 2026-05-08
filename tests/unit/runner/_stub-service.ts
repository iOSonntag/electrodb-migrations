/**
 * Shared mock service for Phase 4 runner unit tests.
 *
 * Extends `tests/unit/state-mutations/_stub-service.ts` with the additional
 * chains the runner uses:
 *
 *   - `entity.scan.go({cursor?, limit?})` — captured as `op: 'scan'`. Tests
 *     enqueue page responses via `setScanPages(pages)` so the stub returns one
 *     page per call and `cursor: null` on the last page.
 *
 *   - `entity.put(record).params()` — captured as `op: 'put-params'`. Returns
 *     the record verbatim (a v1→v2 marshal is a no-op for unit tests; the runner
 *     uses `.params()` to obtain the raw DDB put request for batch inclusion).
 *
 *   - `batchWriteSendSpy` — a `vi.fn()` the runner's batch-flush calls; default
 *     implementation returns `{ UnprocessedItems: undefined }` (all written). Tests
 *     can override per-call via `batchWriteSendSpy.mockResolvedValueOnce(...)`.
 *
 * Phase 4 module → capture mapping:
 *   - `scan-pipeline.ts`  → `op: 'scan'` captures (cursor + limit per call)
 *   - `batch-flush.ts`    → `op: 'put-params'` captures + `batchWriteSendSpy` calls
 *   - `apply-flow.ts`     → composes both; inherits all captures
 *   - `finalize-flow.ts`  → `op: 'scan'` + `op: 'delete'` (delete added when needed)
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Captured record types
// ---------------------------------------------------------------------------

export type RunnerCapturedOp = 'scan' | 'put-params' | 'patch' | 'put' | 'update' | 'get';

export interface RunnerCaptured {
  op: RunnerCapturedOp;
  /** For scan: the options passed to `.go(opts)` */
  scanOpts?: { cursor?: string | null; limit?: number } | undefined;
  /** For put-params: the record passed to `.put(record)` */
  record?: Record<string, unknown> | undefined;
  /** For patch/update: the set values */
  set?: Record<string, unknown> | undefined;
  /** For put: the put values */
  put?: Record<string, unknown> | undefined;
  /** For get: the key */
  get?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

/**
 * Build a scan-chain stub backed by an enqueued page list.
 *
 * Each call to `.go(opts)` pops the next page from `pagesQueue` and returns:
 *   `{ data: page, cursor: pagesQueue.length > 0 ? 'page-token' : null }`
 *
 * When the queue is exhausted, subsequent calls return `{ data: [], cursor: null }`.
 */
function makeScanChain(
  captured: RunnerCaptured[],
  pagesQueue: Array<Array<Record<string, unknown>>>,
): { go: (opts?: { cursor?: string | null; limit?: number }) => Promise<{ data: Array<Record<string, unknown>>; cursor: string | null }> } {
  return {
    go: vi.fn(async (opts?: { cursor?: string | null; limit?: number }) => {
      const entry: RunnerCaptured = { op: 'scan', scanOpts: opts };
      captured.push(entry);
      const page = pagesQueue.shift() ?? [];
      const cursor = pagesQueue.length > 0 ? 'page-token' : null;
      return { data: page, cursor };
    }),
  };
}

/**
 * Build a put-params chain for the given record.
 *
 * The runner calls `entity.put(record).params()` to obtain the raw DDB put
 * request before handing it off to `BatchWriteCommand`. The stub returns the
 * record verbatim as the "params" (unit tests assert runner orchestration,
 * not DDB wire format).
 */
function makePutParamsChain(record: Record<string, unknown>, captured: RunnerCaptured[]): { params: () => Promise<Record<string, unknown>> } {
  return {
    params: vi.fn(async () => {
      captured.push({ op: 'put-params', record });
      return record;
    }),
  };
}

// ---------------------------------------------------------------------------
// Entity stub
// ---------------------------------------------------------------------------

/**
 * Build a runner entity stub with scan + put.params + put.go + patch + get chains.
 *
 * The `pagesQueue` reference is shared with the outer factory so `setScanPages`
 * can replace its contents between test steps.
 */
function makeRunnerEntityStub(captured: RunnerCaptured[], pagesQueue: Array<Array<Record<string, unknown>>>) {
  return {
    scan: makeScanChain(captured, pagesQueue),
    put: (record: Record<string, unknown>) => ({
      /** For batch-flush: returns the record as a mock DDB put request. */
      params: makePutParamsChain(record, captured).params,
      /** For direct single-record writes (finalize delete path uses entity.put().go()). */
      go: vi.fn(async () => {
        captured.push({ op: 'put', put: record });
        return { data: null };
      }),
    }),
    patch: (key: Record<string, unknown>) => {
      const entry: RunnerCaptured = { op: 'patch', get: key };
      const chain = {
        set(values: Record<string, unknown>) {
          entry.set = { ...(entry.set ?? {}), ...values };
          return chain;
        },
        go: vi.fn(async () => {
          captured.push(entry);
          return { data: null };
        }),
      };
      return chain;
    },
    get: (key: Record<string, unknown>) => ({
      go: vi.fn(async () => {
        captured.push({ op: 'get', get: key });
        return { data: null };
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Top-level factory
// ---------------------------------------------------------------------------

/**
 * The object returned by `makeRunnerStubService`.
 *
 * @property service         - Mock service bundle accepted by runner modules.
 * @property captured        - Ordered list of all calls made to entity stubs.
 * @property setScanPages    - Enqueue pages for subsequent `.scan.go()` calls.
 *                             Call before the runner scan loop so each page pop
 *                             corresponds to one cursor advance.
 * @property setGetResult    - Override the value returned by `.get().go()`.
 * @property batchWriteSendSpy - vi.fn() that the runner's batch-flush calls
 *                             instead of `client.send(new BatchWriteCommand(...))`.
 *                             Default returns `{ UnprocessedItems: undefined }`.
 */
export interface RunnerStubService {
  service: {
    service: { transaction: { write: ReturnType<typeof vi.fn> } };
    migrations: ReturnType<typeof makeRunnerEntityStub>;
    migrationState: ReturnType<typeof makeRunnerEntityStub>;
    migrationRuns: ReturnType<typeof makeRunnerEntityStub>;
  };
  captured: RunnerCaptured[];
  /**
   * Enqueue scan pages.
   *
   * Two accepted shapes:
   *   - `Array<Array<Record>>` — pages-of-pages targeting the `migrationState` queue
   *     (default scan target for scan-pipeline / apply-flow tests).
   *   - `Array<Record>` — flat row list targeting the `migrations` queue as a
   *     SINGLE page (used by load-pending tests that scan `_migrations`).
   */
  setScanPages: (
    pages: Array<Array<Record<string, unknown>>> | Array<Record<string, unknown>>,
  ) => void;
  setGetResult: (result: { data: Record<string, unknown> | null }) => void;
  batchWriteSendSpy: ReturnType<typeof vi.fn>;
  /**
   * DynamoDB document client stub whose `.send` is `batchWriteSendSpy`.
   * Used by `batch-flush.ts` tests to assert RequestItems shape.
   */
  client: { send: ReturnType<typeof vi.fn> };
  /**
   * Factory for a minimal Migration-shaped stub: `{from: {scan: {go}}, to: {put(record).params()}}`.
   * Used by `batch-flush.ts` and downstream tests that compose against a Migration value
   * rather than a service bundle.
   */
  makeMigration: () => {
    from: { scan: { go: ReturnType<typeof vi.fn> } };
    to: { put: (record: unknown) => { params: () => Record<string, unknown> } };
  };
  /**
   * Alias for `service.migrations.scan.go` — exposed for load-pending tests
   * that need to assert scan-call counts directly.
   */
  scanGoSpy: ReturnType<typeof vi.fn>;
}

/**
 * Create a self-contained runner stub service for Phase 4 unit tests.
 *
 * Example — testing a scan-pipeline page loop:
 * ```typescript
 * const { service, setScanPages, captured } = makeRunnerStubService();
 * setScanPages([[{ id: 'u-000001', name: 'User 1' }], []]);
 * await scanPipeline({ entity: service.migrationState as any, batchSize: 25 }, async (page) => {
 *   // assert page contents
 * });
 * expect(captured.filter((c) => c.op === 'scan').length).toBe(2); // two pages
 * ```
 */
export function makeRunnerStubService(): RunnerStubService {
  const captured: RunnerCaptured[] = [];
  let getResult: { data: Record<string, unknown> | null } = { data: null };

  // Separate page queues per entity stub (migrationState is the primary scan target).
  const migrationStatePagesQueue: Array<Array<Record<string, unknown>>> = [];
  const migrationsPagesQueue: Array<Array<Record<string, unknown>>> = [];
  const migrationRunsPagesQueue: Array<Array<Record<string, unknown>>> = [];

  const migrationState = makeRunnerEntityStub(captured, migrationStatePagesQueue);
  const migrations = makeRunnerEntityStub(captured, migrationsPagesQueue);
  const migrationRuns = makeRunnerEntityStub(captured, migrationRunsPagesQueue);

  // Wire getResult override for migrationState.get().go()
  const originalMigrationStateGet = migrationState.get.bind(migrationState);
  migrationState.get = (key: Record<string, unknown>) => {
    const chain = originalMigrationStateGet(key);
    const originalGo = chain.go;
    chain.go = vi.fn(async () => {
      const result = await originalGo();
      return { ...result, ...getResult };
    });
    return chain;
  };

  const goSpy = vi.fn(async () => ({}));
  const writeFn = vi.fn((callback: (entities: Record<string, unknown>) => readonly unknown[]) => {
    const items = callback({ migrationState, migrations, migrationRuns } as unknown as Record<string, unknown>);
    void items.length;
    return { go: goSpy };
  });

  const batchWriteSendSpy = vi.fn(async () => ({ UnprocessedItems: undefined }));

  const service = {
    service: { transaction: { write: writeFn } },
    migrations,
    migrationState,
    migrationRuns,
  };

  const client = { send: batchWriteSendSpy };

  const makeMigration = () => {
    const scanGo = vi.fn(async (_opts?: { cursor?: string | null; limit?: number }) => {
      const page = migrationStatePagesQueue.shift();
      if (!page) return { data: [], cursor: null };
      return { data: page, cursor: migrationStatePagesQueue.length > 0 ? 'next' : null };
    });
    return {
      from: { scan: { go: scanGo } },
      to: {
        put: (record: unknown) => ({
          params: () => record as Record<string, unknown>,
        }),
      },
    };
  };

  return {
    service: service as RunnerStubService['service'],
    captured,
    setScanPages: (pages) => {
      // Detect shape: pages-of-pages (Array<Array<Record>>) vs flat rows (Array<Record>).
      // Flat rows feed the migrations queue as a single page (load-pending convention).
      if (pages.length === 0) {
        migrationStatePagesQueue.length = 0;
        migrationsPagesQueue.length = 0;
        return;
      }
      const first = pages[0];
      if (Array.isArray(first)) {
        migrationStatePagesQueue.length = 0;
        for (const page of pages as Array<Array<Record<string, unknown>>>) {
          migrationStatePagesQueue.push(page);
        }
      } else {
        migrationsPagesQueue.length = 0;
        migrationsPagesQueue.push(pages as Array<Record<string, unknown>>);
      }
    },
    scanGoSpy: migrations.scan.go as ReturnType<typeof vi.fn>,
    setGetResult: (result) => {
      getResult = result;
    },
    batchWriteSendSpy,
    client,
    makeMigration,
  };
}
