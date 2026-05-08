/**
 * GRD-05 — `blockMode` allowlist behavior.
 *
 * `blockMode: 'all'` (the default) gates BOTH reads and writes during a
 * gating lock state. `blockMode: 'writes-only'` lets `GetCommand` /
 * `QueryCommand` / `ScanCommand` / `BatchGet` / `TransactGet` through during
 * apply (so a read-heavy fleet can keep serving stale-but-not-corrupt reads
 * during the migration window) and blocks every write.
 *
 * Plan 05's unit suite (`tests/unit/guard/wrap.test.ts`) verifies the
 * `blockMode` branch in the middleware closure. This integration slice
 * verifies it end-to-end against a guarded client + DDB Local with the
 * lock state actually set to 'apply' on disk.
 *
 * The describe-level `beforeAll` bootstraps the lock row to 'free' and then
 * promotes it to 'apply' via `acquireLock` — same pattern as
 * `intercept-all-commands.test.ts`. The lock stays in 'apply' across all
 * three tests; each test creates a fresh guarded client to avoid
 * cross-test middleware accumulation.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const writesOnlyConfig: ResolvedConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: 'local',
  tableName: 'unused-here',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'writes-only' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

const blockAllConfig: ResolvedConfig = {
  ...writesOnlyConfig,
  guard: { cacheTtlMs: 100, blockMode: 'all' },
};

describe('GRD-05: blockMode allowlist behavior', () => {
  const tableName = randomTableName('grd-05');
  const innerClients = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(innerClients.raw, tableName);
    // Bootstrap lockState='free' so acquireLock can promote to 'apply'
    // (ElectroDB patch() requires existence — see clauses.js lines 621-624).
    const innerService = createMigrationsService(innerClients.doc, tableName);
    await innerService.migrationState
      .put({
        id: 'state',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lockState: 'free',
      })
      .go();
    await acquireLock(innerService, blockAllConfig, { mode: 'apply', migId: 'mig-bm', runId: 'r-bm', holder: 'h' });
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(innerClients.raw, tableName);
  });

  it('writes-only: GetCommand passes through during apply', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const innerService = createMigrationsService(innerClients.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: writesOnlyConfig, internalService: innerService }) as typeof guarded.doc;
    // The GetCommand against a non-existent key returns Item: undefined — but
    // the request goes through the wire (the assertion is the absence of a
    // rejected promise; reading a non-existent key is the common-case "user
    // GET on app data during a migration window").
    const result = await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'no', sk: 'such' } }));
    expect(result.Item).toBeUndefined();
  }, 15_000);

  it('writes-only: PutCommand throws during apply', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const innerService = createMigrationsService(innerClients.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: writesOnlyConfig, internalService: innerService }) as typeof guarded.doc;
    await expect(wrapped.send(new PutCommand({ TableName: tableName, Item: { pk: 'a', sk: 'b' } }))).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
    });
  }, 15_000);

  it("blockMode: 'all' gates BOTH reads and writes during apply", async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const innerService = createMigrationsService(innerClients.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: blockAllConfig, internalService: innerService }) as typeof guarded.doc;
    await expect(wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }))).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
    });
  }, 15_000);
});
