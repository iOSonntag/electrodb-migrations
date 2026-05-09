/**
 * BLOCKER 1 — Integration tests for `runUnlock` against DDB Local.
 *
 * Covers ALL FOUR lockState cells per VALIDATION invariant 15:
 *   Cell #1: lockState='apply'    → cleared to 'failed'; _migrations.status='failed' (OQ2)
 *   Cell #2: lockState='release'  → cleared to 'free';   _migrations.status='applied' (no OQ2)
 *   Cell #3: lockState='finalize' → cleared to 'failed'; _migrations.status='failed' (OQ2)
 *   Cell #4: lockState='rollback' → cleared to 'failed'; _migrations.status='failed' (OQ2)
 *
 * Plus CLI ergonomics cases:
 *   UC-05: lockState='free' → early-exit, no writes
 *   UC-06: confirmation 'y' → forceUnlock executes
 *   UC-07: confirmation 'n' → forceUnlock NOT called; rows unchanged
 *
 * DDB Local injection strategy: spy on `createMigrationsClient` from `src/client/index.js`
 * to replace the DDB client arg with a DDB-Local-connected one.
 *
 * References: PLAN 05-11 BLOCKER 1 + BLOCKER 3 + VALIDATION invariant 15.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import {
  createMigrationsService,
  MIGRATIONS_SCHEMA_VERSION,
  MIGRATION_STATE_ID,
} from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { transitionToReleaseMode } from '../../../src/state-mutations/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// ---------------------------------------------------------------------------
// vi.mock declarations — must be at module level
// ---------------------------------------------------------------------------

vi.mock('../../../src/cli/shared/resolve-config.js', () => ({
  resolveCliConfig: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue('y'),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { runUnlock } from '../../../src/cli/commands/unlock.js';
import { resolveCliConfig } from '../../../src/cli/shared/resolve-config.js';
import { createInterface } from 'node:readline/promises';

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

const RUN_ID = 'test-run-unlock-001';
const MIG_ID = 'mig-unlock-X';
const HOLDER = 'test-host:9999';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Write a _migrations audit row at the given status for a migration.
 */
// biome-ignore lint/suspicious/noExplicitAny: bundle type is complex ElectroDB shape
async function seedMigrationsRow(service: any, migId: string, status: 'pending' | 'applied' | 'failed'): Promise<void> {
  await service.migrations
    .put({
      id: migId,
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform' as const,
      status,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
      fingerprint: '',
      ...(status === 'applied'
        ? { appliedAt: new Date().toISOString(), appliedRunId: RUN_ID }
        : {}),
    } as never)
    .go();
}

// ---------------------------------------------------------------------------
// Cell #1: lockState='apply' → cleared to 'failed'; OQ2 patch applied
// ---------------------------------------------------------------------------

describe("BLOCKER 1 Cell #1: lockState='apply' cleared by runUnlock", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-apply');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);

    // Seed _migrations row (status='pending' — apply was in flight)
    await seedMigrationsRow(service, MIG_ID, 'pending');

    // Acquire lock in 'apply' mode (creates _migration_runs row)
    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'apply',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-01: apply cleared → _migration_state=failed, _migrations=failed (OQ2), _migration_runs patched', async () => {
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

    // Inject DDB Local
    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID, yes: true });
    } finally {
      createSpy.mockRestore();
    }

    // Verify lock cleared to 'failed'
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('failed');

    // BLOCKER 3 — OQ2 patch: _migrations.status='failed'
    const migRow = (await service.migrations.get({ id: MIG_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('failed');

    // _migration_runs row was patched to status='failed' by markFailed
    const runsRow = (await service.migrationRuns.get({ runId: RUN_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(runsRow.data?.status).toBe('failed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cell #2: lockState='release' → cleared to 'free'; NO OQ2 patch
// ---------------------------------------------------------------------------

describe("BLOCKER 1 Cell #2: lockState='release' cleared by runUnlock", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-release');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);

    // Seed _migrations row (status='applied' — release-mode is post-success)
    await seedMigrationsRow(service, MIG_ID, 'applied');

    // Acquire lock in 'apply' mode (creates _migration_runs row with runId=RUN_ID)
    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'apply',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );

    // Transition to release mode (post-successful apply)
    await runUnguarded(() =>
      transitionToReleaseMode(service, {
        runId: RUN_ID,
        migId: MIG_ID,
        outcome: 'applied',
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-02: release cleared → _migration_state=free, _migrations=applied (UNCHANGED, no OQ2)', async () => {
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

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID, yes: true });
    } finally {
      createSpy.mockRestore();
    }

    // Verify lock cleared to 'free'
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('free');

    // _migrations.status must remain 'applied' (no OQ2 patch for release priorState)
    const migRow = (await service.migrations.get({ id: MIG_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('applied');

    // _migration_runs row was patched to status='completed' by transitionToReleaseMode
    const runsRow = (await service.migrationRuns.get({ runId: RUN_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(runsRow.data?.status).toBe('completed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cell #3: lockState='finalize' → cleared to 'failed'; OQ2 patch applied
// ---------------------------------------------------------------------------

describe("BLOCKER 1 Cell #3: lockState='finalize' cleared by runUnlock", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-finalize');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);

    // Seed _migrations row (status='applied' — finalize is run against applied migrations)
    await seedMigrationsRow(service, MIG_ID, 'applied');

    // Acquire lock in 'finalize' mode (creates _migration_runs row)
    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'finalize',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-03: finalize cleared → _migration_state=failed, _migrations=failed (OQ2), _migration_runs patched', async () => {
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

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID, yes: true });
    } finally {
      createSpy.mockRestore();
    }

    // Verify lock cleared to 'failed'
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('failed');

    // BLOCKER 3 — OQ2 patch: _migrations.status='failed'
    const migRow = (await service.migrations.get({ id: MIG_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('failed');

    // _migration_runs row was patched to status='failed' by markFailed
    const runsRow = (await service.migrationRuns.get({ runId: RUN_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(runsRow.data?.status).toBe('failed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Cell #4: lockState='rollback' → cleared to 'failed'; OQ2 patch applied
// ---------------------------------------------------------------------------

describe("BLOCKER 1 Cell #4: lockState='rollback' cleared by runUnlock", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-rollback');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);

    // Seed _migrations row (status='applied' — rollback was in flight against applied)
    await seedMigrationsRow(service, MIG_ID, 'applied');

    // Acquire lock in 'rollback' mode (creates _migration_runs row)
    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'rollback',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-04: rollback cleared → _migration_state=failed, _migrations=failed (OQ2), _migration_runs patched', async () => {
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

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID, yes: true });
    } finally {
      createSpy.mockRestore();
    }

    // Verify lock cleared to 'failed'
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('failed');

    // BLOCKER 3 — OQ2 patch: _migrations.status='failed'
    const migRow = (await service.migrations.get({ id: MIG_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('failed');

    // _migration_runs row was patched to status='failed' by markFailed
    const runsRow = (await service.migrationRuns.get({ runId: RUN_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(runsRow.data?.status).toBe('failed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// UC-05: lockState='free' → early-exit
// ---------------------------------------------------------------------------

describe("CLI ergonomics UC-05: lockState='free' → early-exit", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-free');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-05: free lock → early-exit with log.info, no writes', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: makeTestConfig(tableName),
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID, yes: true });
    } finally {
      createSpy.mockRestore();
    }

    const stderr = stderrChunks.join('');
    expect(stderr).toContain('Lock is already free');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// UC-06: interactive 'y' confirmation → executes forceUnlock
// ---------------------------------------------------------------------------

describe("CLI ergonomics UC-06: interactive 'y' → forceUnlock executes", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-yes');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);
    await seedMigrationsRow(service, MIG_ID, 'pending');

    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'apply',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-06: typing y at confirmation prompt → lock cleared', async () => {
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

    // readline mocked to return 'y' (module-level mock; default returns 'y')
    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close: vi.fn(),
    } as never);

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID /* no yes */ });
    } finally {
      createSpy.mockRestore();
    }

    // Lock should now be 'failed' (apply → failed)
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('failed');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// UC-07: interactive 'n' → forceUnlock NOT called; rows unchanged
// ---------------------------------------------------------------------------

describe("CLI ergonomics UC-07: interactive 'n' → abort", () => {
  let alive = false;
  let tableName: string;
  let ddbLocal: DynamoDBClient;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('unlock-cli-no');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
    ddbLocal = makeDdbLocalRawClient();

    const service = createMigrationsService(doc, tableName);
    await seedMigrationsRow(service, MIG_ID, 'pending');

    await runUnguarded(() =>
      acquireLock(service, makeTestConfig(tableName), {
        mode: 'apply',
        migId: MIG_ID,
        runId: RUN_ID,
        holder: HOLDER,
      }),
    );
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
    if (ddbLocal) ddbLocal.destroy();
  });

  it('UC-07: typing n at confirmation → lock UNCHANGED (still apply), Aborted logged', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: makeTestConfig(tableName),
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue('n'),
      close: vi.fn(),
    } as never);

    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal }),
    );

    try {
      await runUnlock({ cwd: '/fake', runId: RUN_ID /* no yes */ });
    } finally {
      createSpy.mockRestore();
    }

    // Lock should remain 'apply' (forceUnlock was NOT called)
    const service = createMigrationsService(doc, tableName);
    const lockRow = (await service.migrationState.get({ id: MIGRATION_STATE_ID }).go()) as {
      data: { lockState: string } | null;
    };
    expect(lockRow.data?.lockState).toBe('apply');

    // _migrations.status should still be 'pending' (no OQ2 patch)
    const migRow = (await service.migrations.get({ id: MIG_ID }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('pending');

    // 'Aborted' is logged
    expect(stderrChunks.join('')).toContain('Aborted');
  }, 30_000);
});
