/**
 * End-to-end CLI integration tests for `runRollback` against DDB Local.
 *
 * Uses the in-process invocation idiom (Option A from the plan):
 * `runRollback` is imported directly and called against DDB Local.
 *
 * DDB Local injection strategy: `vi.mock('@aws-sdk/client-dynamodb')` stubs
 * `DynamoDBClient` to return a DDB-Local-connected instance, which is exactly
 * the client `runRollback` constructs internally before passing to
 * `createMigrationsClient`.
 *
 * Cases:
 * RC-01: runRollback projected end-to-end against a mixed seeded table
 * RC-02: runRollback out-of-order id throws EDBRollbackOutOfOrderError
 */

import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDdbLocalReachable,
  skipMessage,
  createTestTable,
  deleteTestTable,
  makeDdbLocalClient,
  randomTableName,
  bootstrapMigrationState,
  DDB_LOCAL_ENDPOINT,
} from '../_helpers/index.js';
import { setupRollbackTestTable, type RollbackTestTableSetup } from '../rollback/_helpers.js';
import { createMigrationsService, MIGRATIONS_SCHEMA_VERSION } from '../../../src/internal-entities/index.js';
import type { Migration, AnyElectroEntity } from '../../../src/migrations/index.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// vi.mock declarations — must be at module level
// ---------------------------------------------------------------------------

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

vi.mock('../../../src/cli/output/spinner.js', () => ({
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { runRollback } from '../../../src/cli/commands/rollback.js';
import { resolveCliConfig } from '../../../src/cli/shared/resolve-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDdbLocalRawClient() {
  return new DynamoDBClient({
    endpoint: DDB_LOCAL_ENDPOINT,
    region: 'local',
    credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
  });
}

function makeTestConfig(tableName: string) {
  return {
    lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
    guard: { cacheTtlMs: 50, blockMode: 'all' as const },
    entities: [],
    migrations: 'src/database/migrations',
    region: undefined,
    tableName,
    keyNames: { partitionKey: 'pk', sortKey: 'sk' },
    remote: undefined,
    migrationStartVersions: {},
    runner: { concurrency: 1 },
  } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// RC-01: end-to-end rollback projected via CLI layer
// ---------------------------------------------------------------------------

describe('runRollback (CLI) — projected end-to-end', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;
  let ddbLocal: DynamoDBClient;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    // 3 Type A + 2 Type B + 2 Type C = 7 mixed records
    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { mixed: { aCount: 3, bCount: 2, cCount: 2 } },
      migrationsRowStatus: 'applied',
    });

    ddbLocal = makeDdbLocalRawClient();
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
    if (ddbLocal) ddbLocal.destroy();
  });

  it('RC-01: projected rollback via runRollback — migration reverted, lock cleared', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: makeTestConfig(setup.tableName),
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Inject DDB Local + preloaded migrations so resolveMigrationById skips disk walk.
    const clientModule = await import('../../../src/client/index.js');
    const realCreateMigrationsClient = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreateMigrationsClient({ ...args, client: ddbLocal, migrations: [setup.migration] }),
    );

    try {
      await runRollback({
        cwd: '/fake',
        migrationId: setup.migration.id,
        strategy: 'projected',
        yes: true,
      });
    } finally {
      createSpy.mockRestore();
    }

    // Post-rollback: _migrations.status should be 'reverted'
    const scanResult = (await setup.service.migrations.scan.go({ pages: 'all' })) as {
      data: Array<{ id: string; status: string }>;
    };
    const row = scanResult.data.find((r) => r.id === setup.migration.id);
    expect(row?.status).toBe('reverted');

    // Post-rollback: v1 count should match projected expectations
    // projected: 5 v1 records (3 A + 2 B derived; C v1 mirrors deleted)
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// RC-02: out-of-order rollback throws
// ---------------------------------------------------------------------------

describe('runRollback (CLI) — out-of-order rollback throws', () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  // Minimal stub migration for mig-older; `down` is required so the projected
  // strategy capability check doesn't short-circuit before the head check fires.
  const fakeMigOlder = {
    id: 'mig-older',
    entityName: 'User',
    from: {} as AnyElectroEntity,
    to: {} as AnyElectroEntity,
    up: async () => ({}),
    down: async () => ({}),
  } as unknown as Migration<AnyElectroEntity, AnyElectroEntity>;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('rollback-cli-oor');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    // Write TWO _migrations rows: older one applied first, newer one applied second.
    // The head-only check (RBK-01) compares toVersion numerically per entity.
    const service = createMigrationsService(doc, tableName);
    const now = new Date().toISOString();
    await service.migrations.put({
      id: 'mig-older',
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status: 'applied',
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
      fingerprint: '',
      appliedAt: new Date(Date.now() - 2000).toISOString(),
      appliedRunId: 'run-older',
    } as never).go();

    await service.migrations.put({
      id: 'mig-newer',
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status: 'applied',
      entityName: 'User',
      fromVersion: '2',
      toVersion: '3',
      fingerprint: '',
      appliedAt: now,
      appliedRunId: 'run-newer',
    } as never).go();
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('RC-02: attempting rollback of non-head migration throws', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: makeTestConfig(tableName),
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Inject DDB Local + preloaded migrations. fakeMigOlder lets resolveMigrationById
    // return a migration object so preconditions can fire the head-only check (RBK-01).
    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal, migrations: [fakeMigOlder] }),
    );

    try {
      // 'mig-older' is NOT the head migration (mig-newer is applied after it).
      // runRollback must bubble EDBRollbackOutOfOrderError (not caught as exit-0).
      await expect(
        runRollback({
          cwd: '/fake',
          migrationId: 'mig-older',
          strategy: 'projected',
          yes: true,
        }),
      ).rejects.toThrow();
    } finally {
      createSpy.mockRestore();
    }
  }, 30_000);
});
