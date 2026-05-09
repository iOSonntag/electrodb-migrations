/**
 * WARNING 2 — Golden-output test for the rollback success-summary line.
 *
 * This test pins the CLI's success summary format to the canonical itemCounts
 * key labels in fixed order:
 *
 *   • scanned: <N>, reverted: <N>, deleted: <N>, skipped: <N>, failed: <N>
 *
 * The literal keys `scanned:`, `reverted:`, `deleted:`, `skipped:`, `failed:`
 * are the stable contract; the values are computed at runtime.
 *
 * Referenced by PLAN 05-11 WARNING 2 + acceptance criteria.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  isDdbLocalReachable,
  skipMessage,
  DDB_LOCAL_ENDPOINT,
} from '../_helpers/index.js';
import { setupRollbackTestTable, type RollbackTestTableSetup } from '../rollback/_helpers.js';
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
// WARNING 2 golden-output test
// ---------------------------------------------------------------------------

describe('rollback CLI success summary — WARNING 2 golden format', () => {
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

  it('WARNING 2: success summary contains all five canonical itemCounts keys in fixed order', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    vi.mocked(resolveCliConfig).mockResolvedValue({
      config: makeTestConfig(setup.tableName),
      configPath: '/fake/config.ts',
      cwd: '/fake',
    });

    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    // Inject DDB Local + preloaded migrations so resolveMigrationById skips disk walk.
    const clientModule = await import('../../../src/client/index.js');
    const realCreate = clientModule.createMigrationsClient;
    const createSpy = vi.spyOn(clientModule, 'createMigrationsClient').mockImplementation((args) =>
      realCreate({ ...args, client: ddbLocal, migrations: [setup.migration] }),
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

    const allStderr = stderrChunks.join('');

    // WARNING 2: the summary line must match the canonical regex
    // Format: `  • scanned: N, reverted: N, deleted: N, skipped: N, failed: N`
    const summaryPattern = /•\s+scanned:\s+\d+,\s+reverted:\s+\d+,\s+deleted:\s+\d+,\s+skipped:\s+\d+,\s+failed:\s+\d+/m;
    expect(allStderr).toMatch(summaryPattern);

    // All five literal key labels must be present
    expect(allStderr).toContain('scanned:');
    expect(allStderr).toContain('reverted:');
    expect(allStderr).toContain('deleted:');
    expect(allStderr).toContain('skipped:');
    expect(allStderr).toContain('failed:');

    // Keys must appear in fixed order
    const sIdx = allStderr.indexOf('scanned:');
    const revIdx = allStderr.indexOf('reverted:');
    const delIdx = allStderr.indexOf('deleted:');
    const skpIdx = allStderr.indexOf('skipped:');
    const failIdx = allStderr.indexOf('failed:');
    expect(sIdx).toBeLessThan(revIdx);
    expect(revIdx).toBeLessThan(delIdx);
    expect(delIdx).toBeLessThan(skpIdx);
    expect(skpIdx).toBeLessThan(failIdx);

    // For a 7-record mixed (3A+2B+2C) projected rollback:
    // scanned=7, reverted=5 (A+B), deleted=2 (C mirrors), skipped=0, failed=0
    expect(allStderr).toContain('scanned: 7');
    expect(allStderr).toContain('reverted: 5');
    expect(allStderr).toContain('deleted: 2');
    expect(allStderr).toContain('skipped: 0');
    expect(allStderr).toContain('failed: 0');
  }, 60_000);
});
