/**
 * GRD-03 + GRD-07 — guard cache TTL, in-flight dedup, and Lambda thaw guard
 * exercised against real DDB Local with real wall-clock timing.
 *
 * Plan 05's unit suite (`tests/unit/guard/cache.test.ts`) verifies the cache
 * state-machine in isolation with fake timers. This integration slice verifies
 * the same invariants end-to-end through `wrapClient` against a real lock-row
 * GetItem on DDB Local — proving the wall-clock + AWS SDK round-trip preserves
 * the dedup semantics under realistic latencies.
 *
 * **Counter strategy.** We count GetItemCommand calls on a per-test fresh
 * inner client. The only GetItemCommand the framework issues on this client
 * during a test is the cache's `fetchLockState` → `readLockRow` →
 * `migrationState.get(...).go({consistent: CONSISTENT_READ})`. ElectroDB
 * composite keys aren't pattern-matched (the test would otherwise need to
 * re-derive the framework's composite-key prefix, which is brittle); a
 * fresh inner client per test means we observe ONLY the cache's reads.
 *
 * **Setup.** A shared bootstrap client creates the table once and seeds the
 * lock row at `lockState='free'` (`patch()` requires existence — clauses.js
 * lines 621-624; same pattern documented in `intercept-all-commands.test.ts`).
 * Each test then constructs its OWN inner client + counter middleware, wires
 * a guarded client through `wrapClient`, and asserts on the counter.
 */

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const fastConfig: ResolvedConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: 'local',
  tableName: 'unused-here',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 250 },
  guard: { cacheTtlMs: 200, blockMode: 'all' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

interface GetItemCounter {
  count(): number;
}

/**
 * Add a finalize-step middleware that counts GetItemCommand requests against
 * `tableName`. Returns a `count()` getter; the closure captures the counter
 * so the test can assert how many lock-row reads the cache actually issued.
 */
function attachGetItemCounter(client: DynamoDBClient, tableName: string): GetItemCounter {
  let count = 0;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const cmdName = (context as { commandName?: string }).commandName;
      const input = args.input as { TableName?: string };
      if (cmdName === 'GetItemCommand' && input.TableName === tableName) {
        count += 1;
      }
      return next(args);
    },
    { step: 'finalizeRequest', name: 'lock-row-read-counter' },
  );
  return { count: () => count };
}

describe('GRD-03 + GRD-07: cache TTL + in-flight dedup + Lambda thaw guard', () => {
  const tableName = randomTableName('grd-03-07');
  const bootstrap = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(bootstrap.raw, tableName);
    // Seed lockState='free' so guarded operations pass through after the
    // cache's fetchLockState resolves to 'free'. ElectroDB patch() requires
    // existence, but here we use put() (which doesn't require existence) —
    // a fresh state row.
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

  it('two guarded ops within cacheTtlMs share ONE lock-row read', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const inner = makeDdbLocalClient();
    const counter = attachGetItemCounter(inner.raw, tableName);
    const innerService = createMigrationsService(inner.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: fastConfig, internalService: innerService }) as typeof guarded.doc;
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }));
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'c' } }));
    expect(counter.count()).toBe(1);
  }, 15_000);

  it('after cacheTtlMs elapses, a second lock-row read fires (TTL expiry)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const inner = makeDdbLocalClient();
    const counter = attachGetItemCounter(inner.raw, tableName);
    const innerService = createMigrationsService(inner.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: fastConfig, internalService: innerService }) as typeof guarded.doc;
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }));
    await new Promise((r) => setTimeout(r, 250)); // > cacheTtlMs (200ms)
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }));
    expect(counter.count()).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('Lambda thaw guard: wall-clock past 2× cacheTtlMs forces a re-read (GRD-07)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const inner = makeDdbLocalClient();
    const counter = attachGetItemCounter(inner.raw, tableName);
    const innerService = createMigrationsService(inner.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: fastConfig, internalService: innerService }) as typeof guarded.doc;
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }));
    await new Promise((r) => setTimeout(r, 500)); // > 2× cacheTtlMs (400ms)
    await wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } }));
    expect(counter.count()).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('in-flight dedup: concurrent guarded ops within a fetch window share ONE lock-row read (GRD-03)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const inner = makeDdbLocalClient();
    const counter = attachGetItemCounter(inner.raw, tableName);
    const innerService = createMigrationsService(inner.doc, tableName);
    const guarded = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guarded.doc, config: fastConfig, internalService: innerService }) as typeof guarded.doc;
    // Concurrent sends BEFORE any cache is populated → all must await the
    // SAME in-flight fetch promise (Pitfall #1 fan-out — the wire fetch
    // must dedup so the lock-row hot key isn't N-fanned).
    await Promise.all([
      wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'b' } })),
      wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'c' } })),
      wrapped.send(new GetCommand({ TableName: tableName, Key: { pk: 'a', sk: 'd' } })),
    ]);
    expect(counter.count()).toBe(1);
  }, 15_000);
});
