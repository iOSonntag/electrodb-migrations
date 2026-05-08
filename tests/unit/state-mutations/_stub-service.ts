/**
 * Shared mock service for state-mutations unit tests.
 *
 * Records every transactWrite item plus every standalone patch/get call so
 * tests can assert the SHAPE of each verb (item count, ordering, set fields,
 * where-clause substrings) without a real DDB roundtrip.
 *
 * Plan 06 covers the integration tests with real DDB Local and asserts the
 * actual rendered ConditionExpression strings.
 */
import { vi } from 'vitest';

export type CapturedKind = '_migration_state' | '_migrations' | '_migration_runs';
export type CapturedOp = 'patch' | 'put' | 'update' | 'get';

export interface Captured {
  kind: CapturedKind;
  op: CapturedOp;
  set?: Record<string, unknown>;
  add?: Record<string, unknown>;
  delete?: Record<string, unknown>;
  remove?: readonly string[];
  put?: Record<string, unknown>;
  get?: Record<string, unknown>;
  whereCondition?: string;
  commitOptions?: Record<string, unknown>;
  goOptions?: Record<string, unknown>;
}

/**
 * `op` stub — mirrors ElectroDB's where-callback `op` API. Each method
 * returns a tagged string so tests can assert which operators appear inside
 * the composed condition.
 */
export const stubOp = {
  notExists: (a: string) => `notExists(${a})`,
  exists: (a: string) => `exists(${a})`,
  eq: (a: unknown, v: unknown) => `eq(${stringify(a)},${stringify(v)})`,
  ne: (a: unknown, v: unknown) => `ne(${stringify(a)},${stringify(v)})`,
  lt: (a: unknown, v: unknown) => `lt(${stringify(a)},${stringify(v)})`,
  gt: (a: unknown, v: unknown) => `gt(${stringify(a)},${stringify(v)})`,
  contains: (a: unknown, v: unknown) => `contains(${stringify(a)},${stringify(v)})`,
  size: (a: string) => `size(${a})`,
  value: (_a: string, v: unknown) => v,
};

function stringify(x: unknown): string {
  return typeof x === 'string' && !x.includes('"') ? `"${x}"` : JSON.stringify(x);
}

/**
 * Stub attribute proxy — `({lockState, heartbeatAt}, op) => ...` destructures
 * receive the literal attribute name as a string.
 */
export const stubAttrs: Record<string, string> = new Proxy(
  {},
  {
    get: (_target, prop) => prop as string,
  },
) as Record<string, string>;

export interface StubService {
  service: { service: { transaction: { write: ReturnType<typeof vi.fn> } } } & {
    migrations: unknown;
    migrationState: unknown;
    migrationRuns: unknown;
  };
  captured: Captured[];
  writeFn: ReturnType<typeof vi.fn>;
  goSpy: ReturnType<typeof vi.fn>;
  /** Set by tests that mock the `migrationState.get(...).go(...)` lookup. */
  setGetResult: (result: { data: Record<string, unknown> | null }) => void;
}

export function makeStubService(transactionGoImpl?: () => Promise<unknown>): StubService {
  const captured: Captured[] = [];
  let getResult: { data: Record<string, unknown> | null } = { data: null };

  function makeEntityStub(kind: CapturedKind) {
    function patchChain(builder: Captured): unknown {
      const chain = {
        set(values: Record<string, unknown>) {
          builder.set = { ...(builder.set ?? {}), ...values };
          return chain;
        },
        add(values: Record<string, unknown>) {
          builder.add = { ...(builder.add ?? {}), ...values };
          return chain;
        },
        delete(values: Record<string, unknown>) {
          builder.delete = { ...(builder.delete ?? {}), ...values };
          return chain;
        },
        remove(attrs: readonly string[]) {
          builder.remove = attrs;
          return chain;
        },
        where(cb: (attrs: typeof stubAttrs, op: typeof stubOp) => string) {
          builder.whereCondition = cb(stubAttrs, stubOp);
          return chain;
        },
        commit(options?: Record<string, unknown>) {
          if (options !== undefined) builder.commitOptions = options;
          captured.push(builder);
          return builder;
        },
        // Top-level (non-transaction) patch ends in .go(...)
        go: vi.fn(async (options?: Record<string, unknown>) => {
          if (options !== undefined) builder.goOptions = options;
          captured.push(builder);
          return { data: null };
        }),
      };
      return chain;
    }
    function putChain(builder: Captured): unknown {
      const chain = {
        commit(options?: Record<string, unknown>) {
          if (options !== undefined) builder.commitOptions = options;
          captured.push(builder);
          return builder;
        },
        go: vi.fn(async (options?: Record<string, unknown>) => {
          if (options !== undefined) builder.goOptions = options;
          captured.push(builder);
          return { data: null };
        }),
      };
      return chain;
    }
    function getChain(builder: Captured): unknown {
      const chain = {
        go: vi.fn(async (options?: Record<string, unknown>) => {
          if (options !== undefined) builder.goOptions = options;
          captured.push(builder);
          return getResult;
        }),
      };
      return chain;
    }

    return {
      patch: (id: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'patch', get: id };
        return patchChain(builder);
      },
      put: (values: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'put', put: values };
        return putChain(builder);
      },
      update: (id: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'update', get: id };
        return patchChain(builder);
      },
      get: (id: Record<string, unknown>) => {
        const builder: Captured = { kind, op: 'get', get: id };
        return getChain(builder);
      },
    };
  }

  const goSpy = vi.fn(async () => (transactionGoImpl ? transactionGoImpl() : {}));
  const writeFn = vi.fn(
    (callback: (entities: Record<string, unknown>) => readonly unknown[]) => {
      const items = callback({
        migrationState: makeEntityStub('_migration_state'),
        migrations: makeEntityStub('_migrations'),
        migrationRuns: makeEntityStub('_migration_runs'),
      });
      void items.length;
      return { go: goSpy };
    },
  );

  const service = {
    service: { transaction: { write: writeFn } },
    migrations: makeEntityStub('_migrations'),
    migrationState: makeEntityStub('_migration_state'),
    migrationRuns: makeEntityStub('_migration_runs'),
  };

  return {
    service: service as unknown as StubService['service'],
    captured,
    writeFn,
    goSpy,
    setGetResult: (result) => {
      getResult = result;
    },
  };
}
