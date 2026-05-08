/**
 * Shared mock service for runner unit tests (Plan 04-01 infrastructure).
 *
 * Provides a minimal `MigrationsServiceBundle`-compatible stub that supports:
 * - `service.migrations.scan.go({pages: 'all'})` — returns enqueued pages via
 *   `setScanPages()`, enabling deterministic `_migrations` row correlation tests.
 *
 * The stub does NOT attempt to replicate the full state-mutations stub; it targets
 * only the chains used by `loadPendingMigrations` and sibling runner modules.
 */
import { vi } from 'vitest';

/**
 * Minimal `_migrations` row shape for stub scan results.
 */
export interface StubMigrationsRow {
  id: string;
  status: 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';
  entityName?: string;
  fromVersion?: string;
  toVersion?: string;
}

/**
 * The handle returned by `makeRunnerStubService`.
 */
export interface RunnerStubService {
  /**
   * The service bundle — pass to `loadPendingMigrations` as `service`.
   * Typed as `any` to avoid coupling to the internal bundle type here;
   * the production code casts it correctly via its own types.
   */
  // biome-ignore lint/suspicious/noExplicitAny: test stub intentionally typed loose
  service: any;
  /**
   * Enqueue the rows that `service.migrations.scan.go({pages:'all'})` will
   * return on the NEXT call. Resets after each invocation so tests remain
   * independent.
   */
  setScanPages: (rows: StubMigrationsRow[]) => void;
  /** Direct reference to the scan.go spy for assertion purposes. */
  scanGoSpy: ReturnType<typeof vi.fn>;
}

/**
 * Build a runner stub service whose `migrations.scan.go` call returns
 * deterministic data without touching DDB.
 *
 * Usage:
 * ```typescript
 * const { service, setScanPages } = makeRunnerStubService();
 * setScanPages([{ id: 'User-add-status', status: 'applied', entityName: 'User', fromVersion: '1', toVersion: '2' }]);
 * const pending = await loadPendingMigrations({ config, service, cwd });
 * ```
 */
export function makeRunnerStubService(): RunnerStubService {
  let nextRows: StubMigrationsRow[] = [];

  const scanGoSpy = vi.fn(async (_opts?: unknown) => {
    const data = nextRows;
    nextRows = [];
    return { data };
  });

  const service = {
    migrations: {
      scan: {
        go: scanGoSpy,
      },
    },
    // Other service members are not needed by load-pending; stub minimally.
    migrationState: {},
    migrationRuns: {},
    service: { transaction: { write: vi.fn() } },
  };

  return {
    service,
    setScanPages: (rows: StubMigrationsRow[]) => {
      nextRows = rows;
    },
    scanGoSpy,
  };
}
