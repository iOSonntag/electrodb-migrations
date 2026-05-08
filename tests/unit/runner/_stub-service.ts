/**
 * Shared mock service for runner unit tests.
 *
 * Extends the state-mutations stub pattern with the additional chains Phase 4
 * runner modules consume:
 * - `migration.from.scan.go({cursor?, limit?})` — returns enqueued pages
 * - `migration.to.put(record).params()` — returns record verbatim (unit-test marshal no-op)
 * - `client.send(BatchWriteCommand)` — captured via `batchWriteSendSpy`
 *
 * Each test calls `makeRunnerStubService()` to get a fresh instance with no
 * state carried across cases.
 *
 * Consumed by:
 * - `tests/unit/runner/batch-flush.test.ts` — uses `batchWriteSendSpy` + migration stubs
 */
import { vi } from 'vitest';

export interface RunnerScanPage {
  data: Record<string, unknown>[];
  cursor: string | null;
}

export interface RunnerStubService {
  /**
   * A DynamoDB document client stub whose `.send` is `batchWriteSendSpy`.
   * Construct it inline: `{ send: batchWriteSendSpy }`.
   */
  client: { send: ReturnType<typeof vi.fn> };
  /**
   * Spy on BatchWriteCommand sends. Default impl: returns `{ UnprocessedItems: undefined }`.
   * Override per call via `.mockResolvedValueOnce(...)`.
   */
  batchWriteSendSpy: ReturnType<typeof vi.fn>;
  /**
   * Feed scan pages one-by-one. Each call to `from.scan.go()` pops the first
   * enqueued page; after all pages are consumed it returns `{data: [], cursor: null}`.
   */
  setScanPages: (pages: RunnerScanPage[]) => void;
  /**
   * Factory that returns a minimal Migration-shaped stub for unit tests.
   * `migration.to.put(record).params()` returns the record verbatim (no ElectroDB
   * marshalling needed for unit tests — BF-2/BF-7 verify the RequestItems shape
   * using the verbatim item).
   *
   * Tests that need to force a validation failure mock it:
   * `stub.makeMigration().to.put = vi.fn().mockReturnValueOnce({ params: () => { throw new Error('schema validation') } })`
   */
  makeMigration: () => {
    from: {
      scan: {
        go: ReturnType<typeof vi.fn>;
      };
    };
    to: {
      put: (record: unknown) => { params: () => Record<string, unknown> };
    };
  };
}

/**
 * Create a fresh runner stub service for each test case.
 *
 * @example
 * ```typescript
 * const stub = makeRunnerStubService();
 * const migration = stub.makeMigration();
 * const result = await batchFlushV2({ migration, client: stub.client, tableName, records });
 * expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);
 * ```
 */
export function makeRunnerStubService(): RunnerStubService {
  let scanPages: RunnerScanPage[] = [];

  const scanGoSpy = vi.fn(async (_opts?: { cursor?: string | null; limit?: number }) => {
    const page = scanPages.shift();
    return page ?? { data: [], cursor: null };
  });

  const setScanPages = (pages: RunnerScanPage[]) => {
    scanPages = [...pages];
    scanGoSpy.mockClear();
    // Re-implement after clear
    scanGoSpy.mockImplementation(async (_opts?: { cursor?: string | null; limit?: number }) => {
      const p = scanPages.shift();
      return p ?? { data: [], cursor: null };
    });
  };

  const batchWriteSendSpy = vi.fn(async () => ({
    UnprocessedItems: undefined,
  }));

  const client = { send: batchWriteSendSpy };

  const makeMigration = () => ({
    from: {
      scan: {
        go: scanGoSpy,
      },
    },
    to: {
      put: (record: unknown) => ({
        params: () => record as Record<string, unknown>,
      }),
    },
  });

  return {
    client,
    batchWriteSendSpy,
    setScanPages,
    makeMigration,
  };
}
