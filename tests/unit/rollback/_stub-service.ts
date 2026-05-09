/**
 * Shared mock service for Phase 5 rollback unit tests.
 *
 * Extends the runner stub service pattern from `tests/unit/runner/_stub-service.ts`
 * with rollback-specific capture:
 *
 *   - TWO scan-page queues: `setScanPages('v1', pages)` enqueues pages for
 *     `migration.from.scan.go(...)` calls; `setScanPages('v2', pages)` enqueues
 *     pages for `migration.to.scan.go(...)` calls. The `undefined` form (no key)
 *     maintains backward compatibility with the single-queue convention used by
 *     apply-flow-style tests.
 *
 *   - Heterogeneous BatchWrite capture: a `BatchWriteCommand` whose
 *     `RequestItems[tableName]` array contains a MIX of `{PutRequest}` and
 *     `{DeleteRequest}` items. Each call is captured as
 *     `{op: 'batch-write', requestItems: ...}` so unit tests can assert the
 *     exact composition of puts vs. deletes per call.
 *
 *   - `entity.delete(record).params()` capture (`op: 'delete-params'`): returns
 *     the record's `id` packaged as a `{Key: {pk: record.id, sk: record.id}}`
 *     shape so `batch-flush-rollback.ts` (Plan 05-04) can assert the delete
 *     marshalling path without needing a real DDB connection.
 *
 * Phase 5 module → capture mapping:
 *   - `preconditions.ts`     → `op: 'scan'` captures on the `migrations` queue
 *   - `type-table.ts`        → `op: 'scan'` captures on BOTH v1 + v2 queues
 *   - `batch-flush-rollback.ts` → `op: 'put-params'` + `op: 'delete-params'` +
 *                                  `op: 'batch-write'` + `batchWriteSendSpy` calls
 *   - `rollback-orchestrator.ts` → composes all of the above
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Captured record types
// ---------------------------------------------------------------------------

/** Discriminated union of all capture operations for rollback unit tests. */
export type RollbackCapturedOp =
  | 'scan'
  | 'put-params'
  | 'delete-params'
  | 'batch-write'
  | 'patch'
  | 'put'
  | 'update'
  | 'get';

export interface RollbackCaptured {
  op: RollbackCapturedOp;
  /** For scan: the options passed to `.go(opts)` */
  scanOpts?: { cursor?: string | null; limit?: number } | undefined;
  /** For put-params / put: the record passed to `.put(record)` */
  record?: Record<string, unknown> | undefined;
  /** For delete-params: the key shape returned by `.delete(record).params()` */
  deleteKey?: { Key: Record<string, unknown> } | undefined;
  /** For batch-write: the RequestItems passed to the BatchWriteCommand */
  requestItems?: Record<string, Array<{ PutRequest?: unknown; DeleteRequest?: unknown }>> | undefined;
  /** For patch/update: the set values */
  set?: Record<string, unknown> | undefined;
  /** For get: the key */
  get?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Scan chain builder (keyed by entity version)
// ---------------------------------------------------------------------------

type ScanKey = 'v1' | 'v2' | 'default';

/**
 * Build a scan-chain stub backed by an enqueued page list.
 *
 * Each call to `.go(opts)` pops the next page from `pagesQueue` and returns:
 *   `{ data: page, cursor: pagesQueue.length > 0 ? 'page-token' : null }`
 *
 * When the queue is exhausted, subsequent calls return `{ data: [], cursor: null }`.
 */
function makeScanChain(
  captured: RollbackCaptured[],
  pagesQueue: Array<Array<Record<string, unknown>>>,
  scanKey: ScanKey,
): { go: ReturnType<typeof vi.fn> } {
  return {
    go: vi.fn(async (opts?: { cursor?: string | null; limit?: number }) => {
      const entry: RollbackCaptured = { op: 'scan', scanOpts: opts };
      // Annotate scan key in scanOpts so tests can distinguish v1 vs v2 scans.
      if (scanKey !== 'default') {
        entry.scanOpts = { ...(entry.scanOpts ?? {}), _scanKey: scanKey } as typeof entry.scanOpts;
      }
      captured.push(entry);
      const page = pagesQueue.shift() ?? [];
      const cursor = pagesQueue.length > 0 ? 'page-token' : null;
      return { data: page, cursor };
    }),
  };
}

// ---------------------------------------------------------------------------
// Entity stubs for from (v1) and to (v2)
// ---------------------------------------------------------------------------

function makeV1EntityStub(
  captured: RollbackCaptured[],
  pagesQueue: Array<Array<Record<string, unknown>>>,
) {
  return {
    scan: makeScanChain(captured, pagesQueue, 'v1'),
    put: (record: Record<string, unknown>) => ({
      /** For batch-flush rollback: returns the record as a mock DDB put request. */
      params: vi.fn(async () => {
        captured.push({ op: 'put-params', record });
        return record;
      }),
      go: vi.fn(async () => {
        captured.push({ op: 'put', record });
        return { data: null };
      }),
    }),
    delete: (record: Record<string, unknown>) => ({
      /** For batch-flush rollback: returns a minimal `{Key: {pk, sk}}` shape. */
      params: vi.fn(async () => {
        const key = { Key: { pk: record.id ?? record.pk, sk: record.id ?? record.sk } };
        captured.push({ op: 'delete-params', deleteKey: key });
        return key;
      }),
    }),
  };
}

function makeV2EntityStub(
  captured: RollbackCaptured[],
  pagesQueue: Array<Array<Record<string, unknown>>>,
) {
  return {
    scan: makeScanChain(captured, pagesQueue, 'v2'),
    put: (record: Record<string, unknown>) => ({
      params: vi.fn(async () => {
        captured.push({ op: 'put-params', record });
        return record;
      }),
      go: vi.fn(async () => {
        captured.push({ op: 'put', record });
        return { data: null };
      }),
    }),
    delete: (record: Record<string, unknown>) => ({
      params: vi.fn(async () => {
        const key = { Key: { pk: record.id ?? record.pk, sk: record.id ?? record.sk } };
        captured.push({ op: 'delete-params', deleteKey: key });
        return key;
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Service stub for migrations / migrationState / migrationRuns (mirrors runner stub)
// ---------------------------------------------------------------------------

function makeServiceEntityStub(captured: RollbackCaptured[]) {
  const getResult: { data: Record<string, unknown> | null } = { data: null };
  return {
    scan: makeScanChain(captured, [], 'default'),
    put: (record: Record<string, unknown>) => ({
      commit(options?: Record<string, unknown>) {
        void options;
        captured.push({ op: 'put', record });
        return {};
      },
      go: vi.fn(async () => {
        captured.push({ op: 'put', record });
        return { data: null };
      }),
    }),
    patch: (key: Record<string, unknown>) => {
      const entry: RollbackCaptured = { op: 'patch', get: key };
      const chain = {
        set(values: Record<string, unknown>) {
          entry.set = { ...(entry.set ?? {}), ...values };
          return chain;
        },
        add(_values: Record<string, unknown>) { return chain; },
        remove(_attrs: string[]) { return chain; },
        where(_condition: unknown) { return chain; },
        commit(_options?: Record<string, unknown>) {
          captured.push(entry);
          return entry;
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
        return getResult;
      }),
    }),
    _getResult: getResult,
  };
}

// ---------------------------------------------------------------------------
// Top-level factory
// ---------------------------------------------------------------------------

/**
 * The object returned by `makeRollbackStubService`.
 *
 * @property service           - Mock service bundle accepted by rollback modules.
 * @property captured          - Ordered list of all calls made to entity stubs.
 * @property setScanPages      - Enqueue pages for subsequent `.scan.go()` calls.
 *                               Accepts a `ScanKey` ('v1' | 'v2' | undefined)
 *                               to target the correct entity scan queue:
 *                               - `'v1'` → pages for `migration.from.scan.go(...)`
 *                               - `'v2'` → pages for `migration.to.scan.go(...)`
 *                               - `undefined` → pages for the internal `migrations` queue
 *                                 (backward-compat with single-queue convention)
 * @property batchWriteSendSpy - vi.fn() the rollback batch-flush calls instead of
 *                               `client.send(new BatchWriteCommand(...))`.
 * @property client            - DynamoDB document client stub whose `.send` is `batchWriteSendSpy`.
 * @property makeMigration     - Factory for a Migration-shaped stub wrapping the v1 and v2 entity stubs.
 */
export interface RollbackStubService {
  service: {
    service: { transaction: { write: ReturnType<typeof vi.fn> } };
    migrations: ReturnType<typeof makeServiceEntityStub>;
    migrationState: ReturnType<typeof makeServiceEntityStub>;
    migrationRuns: ReturnType<typeof makeServiceEntityStub>;
  };
  captured: RollbackCaptured[];
  /**
   * Enqueue scan pages for the specified entity queue.
   *
   * - `setScanPages('v1', pages)` → pages for `migration.from.scan.go(...)`
   * - `setScanPages('v2', pages)` → pages for `migration.to.scan.go(...)`
   * - `setScanPages(undefined, pages)` → pages for internal `migrations` scan queue
   */
  setScanPages: (
    key: 'v1' | 'v2' | undefined,
    pages: Array<Array<Record<string, unknown>>> | Array<Record<string, unknown>>,
  ) => void;
  setGetResult: (result: { data: Record<string, unknown> | null }) => void;
  batchWriteSendSpy: ReturnType<typeof vi.fn>;
  /**
   * DynamoDB document client stub whose `.send` is `batchWriteSendSpy`.
   * Used by `batch-flush-rollback.ts` tests to assert RequestItems shape.
   */
  client: { send: ReturnType<typeof vi.fn> };
  /**
   * Factory for a Migration-shaped stub that uses the v1 and v2 entity stubs.
   *
   * Tests import this and pass it to the module under test. The returned migration
   * has:
   * - `from.scan.go(...)` — drains from the v1 queue (set via `setScanPages('v1', ...)`)
   * - `to.scan.go(...)` — drains from the v2 queue (set via `setScanPages('v2', ...)`)
   * - `from.put(record).params()` — captured as `op: 'put-params'`
   * - `from.delete(record).params()` — captured as `op: 'delete-params'`
   * - `to.put(record).params()` — captured as `op: 'put-params'`
   */
  makeMigration: (opts?: {
    hasDown?: boolean;
    hasRollbackResolver?: boolean;
  }) => {
    id: string;
    entityName: string;
    from: ReturnType<typeof makeV1EntityStub>;
    to: ReturnType<typeof makeV2EntityStub>;
    up: (record: unknown) => Promise<Record<string, unknown>>;
    down?: (record: unknown) => Promise<Record<string, unknown>>;
    rollbackResolver?: (args: unknown) => Promise<unknown>;
  };
}

/**
 * Create a self-contained rollback stub service for Phase 5 unit tests.
 *
 * Example — testing a type-table classifier that scans both v1 and v2:
 * ```typescript
 * const stub = makeRollbackStubService();
 * stub.setScanPages('v1', [[{ id: 'u-1', name: 'Alice' }]]);
 * stub.setScanPages('v2', [[{ id: 'u-1', name: 'Alice', status: 'active' }]]);
 * const migration = stub.makeMigration();
 * // ... call module under test with migration ...
 * const v1Scans = stub.captured.filter((c) => c.op === 'scan' && (c.scanOpts as any)?._scanKey === 'v1');
 * expect(v1Scans).toHaveLength(1);
 * ```
 */
export function makeRollbackStubService(): RollbackStubService {
  const captured: RollbackCaptured[] = [];
  let getResult: { data: Record<string, unknown> | null } = { data: null };

  // Per-entity scan queues.
  const v1PagesQueue: Array<Array<Record<string, unknown>>> = [];
  const v2PagesQueue: Array<Array<Record<string, unknown>>> = [];
  const migrationsPagesQueue: Array<Array<Record<string, unknown>>> = [];

  // Internal entity stubs for service (migrationState / migrations / migrationRuns).
  const migrationStateStub = makeServiceEntityStub(captured);
  const migrationsStub = makeServiceEntityStub(captured);
  // Replace migrations scan chain to use the shared migrationsPagesQueue.
  migrationsStub.scan = makeScanChain(captured, migrationsPagesQueue, 'default');
  const migrationRunsStub = makeServiceEntityStub(captured);

  // Wire getResult override on migrationState.get().go().
  const originalGet = migrationStateStub.get.bind(migrationStateStub);
  migrationStateStub.get = (key: Record<string, unknown>) => {
    const chain = originalGet(key);
    const originalGo = chain.go;
    chain.go = vi.fn(async () => {
      const result = await originalGo();
      return { ...result, ...getResult };
    });
    return chain;
  };

  const batchWriteSendSpy = vi.fn(async () => ({ UnprocessedItems: undefined }));

  const goSpy = vi.fn(async () => ({}));
  const writeFn = vi.fn((callback: (entities: Record<string, unknown>) => readonly unknown[]) => {
    const items = callback({
      migrationState: migrationStateStub,
      migrations: migrationsStub,
      migrationRuns: migrationRunsStub,
    } as unknown as Record<string, unknown>);
    void items.length;
    return { go: goSpy };
  });

  const service = {
    service: { transaction: { write: writeFn } },
    migrations: migrationsStub,
    migrationState: migrationStateStub,
    migrationRuns: migrationRunsStub,
  };

  const client = { send: batchWriteSendSpy };

  const makeMigration = (opts: { hasDown?: boolean; hasRollbackResolver?: boolean } = {}) => {
    const { hasDown = true, hasRollbackResolver = false } = opts;

    const v1 = makeV1EntityStub(captured, v1PagesQueue);
    const v2 = makeV2EntityStub(captured, v2PagesQueue);

    const migration: RollbackStubService['makeMigration'] extends (opts?: infer _O) => infer R ? R : never = {
      id: 'stub-migration-id',
      entityName: 'User',
      from: v1,
      to: v2,
      up: async (record: unknown) => ({
        ...(record as Record<string, unknown>),
        status: 'active',
      }),
    };

    if (hasDown) {
      (migration as Record<string, unknown>).down = async (record: unknown) => {
        const { status: _s, version: _v, ...v1Shape } = record as Record<string, unknown>;
        return v1Shape;
      };
    }

    if (hasRollbackResolver) {
      (migration as Record<string, unknown>).rollbackResolver = async (args: unknown) => {
        const a = args as { kind: 'A' | 'B' | 'C'; v1Original?: Record<string, unknown> };
        return a.v1Original ?? null;
      };
    }

    return migration;
  };

  return {
    service: service as RollbackStubService['service'],
    captured,
    setScanPages: (key, pages) => {
      const targetQueue =
        key === 'v1' ? v1PagesQueue :
        key === 'v2' ? v2PagesQueue :
        migrationsPagesQueue;

      targetQueue.length = 0;
      if (pages.length === 0) return;

      const first = pages[0];
      if (Array.isArray(first)) {
        for (const page of pages as Array<Array<Record<string, unknown>>>) {
          targetQueue.push(page);
        }
      } else {
        // Flat row list → single page.
        targetQueue.push(pages as Array<Record<string, unknown>>);
      }
    },
    setGetResult: (result) => {
      getResult = result;
    },
    batchWriteSendSpy,
    client,
    makeMigration,
  };
}
