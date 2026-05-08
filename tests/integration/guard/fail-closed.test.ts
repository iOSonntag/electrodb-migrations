/**
 * GRD-06 — guard fails closed when the lock-row read throws.
 *
 * Plan 05's unit suite (`tests/unit/guard/cache.test.ts`) verifies fail-closed
 * behavior with a stub that rejects. This integration slice verifies the same
 * end-to-end through `wrapClient` + a real DDB Local client, with a
 * synthetic-error middleware that throws on GetItemCommand against the lock row.
 *
 * Pitfall #1 mitigation: a transient AWS error (ThrottlingException, network
 * blip) on the lock-row read MUST NOT silently fall through to "lockState=free"
 * — the cache must throw `EDBMigrationInProgressError` and the guard must
 * surface that to the caller as the migration-in-progress signal. The cause
 * chain carries the original error message via `details.cause` so operators
 * can diagnose; the runId/lockState are absent because the read failed
 * (intentional — there's nothing to report).
 *
 * **Synthetic error scope.** The plan's verbatim sketch filters the error
 * middleware by `pk === '_migration_state'` (the literal lock-row key); the
 * framework's reads use ElectroDB's composite key, so a literal-key filter
 * never fires. We instead match `commandName === 'GetItemCommand'` against
 * the test table — the only GetItemCommand the framework issues on this
 * inner client during a test is the cache's `fetchLockState` call.
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const baseConfig: ResolvedConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: 'local',
  tableName: 'unused-here',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

describe('GRD-06: guard fails closed when lock-row read throws', () => {
  const tableName = randomTableName('grd-06');
  const bootstrap = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(bootstrap.raw, tableName);
    // Seed lockState='free' (consistent with cache-ttl test setup) — the
    // failure mode is the read itself rejecting, not the lock state being
    // gated. Without a seed row the cache's read returns null, which the
    // guard maps to 'free' and the test would pass trivially.
    const bootstrapService = createMigrationsService(bootstrap.doc, tableName);
    await bootstrapService.migrationState
      .put({
        id: 'state',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lockState: 'free',
      })
      .go();
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(bootstrap.raw, tableName);
  });

  it('throws EDBMigrationInProgressError with details.cause when the lock-row GetItem rejects', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Inner client with a synthetic-error middleware that fails any GetItem
    // against the test table. Because the cache's only GetItemCommand on
    // this client is the lock-row read, this reliably injects a fail-closed
    // path without needing to filter on the ElectroDB composite key.
    const inner = makeDdbLocalClient();
    inner.raw.middlewareStack.add(
      (next, context) => async (args) => {
        const cmdName = (context as { commandName?: string }).commandName;
        const input = args.input as { TableName?: string };
        if (cmdName === 'GetItemCommand' && input.TableName === tableName) {
          const err = new Error('Synthetic DDB throttle');
          (err as { name: string }).name = 'ThrottlingException';
          throw err;
        }
        return next(args);
      },
      { step: 'finalizeRequest', name: 'synthetic-throttle' },
    );
    const innerService = createMigrationsService(inner.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: baseConfig, internalService: innerService }) as typeof guarded.doc;
    await expect(wrapped.send(new PutCommand({ TableName: tableName, Item: { pk: 'a', sk: 'b' } }))).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
      details: expect.objectContaining({ cause: expect.stringContaining('Synthetic') }),
    });
  }, 15_000);
});
