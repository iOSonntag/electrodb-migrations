/**
 * BLD-04 — eventual-consistency hazard cornerstone test.
 *
 * The DDB Local container is strongly-consistent by default. A `ConsistentRead: false`
 * regression in the framework's lock-row reader would silently pass against
 * DDB Local while corrupting data on real DynamoDB. The Wave 0 simulator
 * (`tests/integration/_helpers/eventual-consistency.ts`) injects a stale-read
 * window so the regression is reproducible pre-deployment.
 *
 * **Two scenarios on the same table:**
 *
 * 1. **UNSAFE-PATH BASELINE** — proves the simulator IS effective. We seed the
 *    lock-row literal key directly via `PutCommand` (not via the framework's
 *    ElectroDB-composite path; the simulator filters on the literal key). With
 *    the stale window open, a non-ConsistentRead read returns the simulator's
 *    recorded stale state; a ConsistentRead read passes through to DDB and
 *    returns the real on-disk state. This test is the simulator's
 *    fitness-for-purpose check; it does NOT exercise the framework's read
 *    path.
 *
 * 2. **SAFE-PATH MITIGATION** — the framework wins. We acquire the lock via
 *    the framework's `acquireLock` (writes through ElectroDB at the
 *    composite key), wrap a guarded client where the internalService's reads
 *    go through the simulator-attached client, and assert the guard
 *    throws `EDBMigrationInProgressError`. The simulator's `!ConsistentRead`
 *    gate means it never intercepts the framework's reads (which all carry
 *    `consistent: CONSISTENT_READ`), so the guard sees the real
 *    `lockState='apply'` and gates correctly.
 *
 * **Per the plan's `<behavior>`**: the assertion in the SAFE-PATH test is on
 * the throw, NOT the simulator's `staleHits()` count — the simulator's stale
 * path may or may not be entered for non-lock-row paths (e.g. ElectroDB's
 * service-version probe), but only the safety throw is load-bearing.
 *
 * Decision A8 (`03-WAVE0-NOTES.md`) — the simulator's synthesized response
 * carries `$metadata` on both `output` and `response`; this is verified by the
 * Wave 0 spike (`tests/integration/_spike/eventual-consistency-prototype.test.ts`)
 * and is NOT this test's concern.
 *
 * **Deviation note (Rule 1 - Bug):** The plan's verbatim UNSAFE-PATH sketch
 * called `acquireLock` to seed the table, then asserted that a raw GetCommand
 * with `ConsistentRead: true` at the literal key returns `lockState='apply'`.
 * This cannot work — `acquireLock` writes through ElectroDB at a composite
 * key (`$_electrodb_migrations#_migration_state_1#id_state` shape), NOT at
 * the literal `pk='_migration_state'/sk='state'` the simulator filters on.
 * A raw read at the literal key would return `Item: undefined`. This file
 * uses a raw `PutCommand` to seed the literal key directly — matching the
 * Wave 0 spike's pattern (`eventual-consistency-prototype.test.ts:46-52`).
 * The SAFE-PATH test still uses the framework's `acquireLock`, which is what
 * the BLD-04 mitigation actually depends on.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { attachEventualConsistencyMiddleware, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

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

describe('BLD-04 + GRD-02: eventual-consistency hazard and CONSISTENT_READ defense', () => {
  const tableName = randomTableName('bld-04');
  const innerClients = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) await createTestTable(innerClients.raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(innerClients.raw, tableName);
  });

  it('UNSAFE-PATH BASELINE: simulator delivers stale `lockState=free` when ConsistentRead is omitted; passes through when ConsistentRead: true', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Seed the LITERAL lock-row key via raw PutCommand (the simulator's filter
    // is `pk === '_migration_state' && sk === 'state'`). This is the simulator
    // fitness-for-purpose check, not a framework path.
    const sim = makeDdbLocalClient();
    const harness = attachEventualConsistencyMiddleware(sim.raw, tableName);

    await sim.doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: '_migration_state', sk: 'state', id: 'state', lockState: 'apply', lockRunId: 'r-real' },
      }),
    );
    harness.recordWrite({ pk: '_migration_state', sk: 'state', id: 'state', lockState: 'free' });
    harness.beginStaleWindow(5_000);

    const stale = await sim.doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: '_migration_state', sk: 'state' },
        // ConsistentRead omitted — simulator intercepts and returns stale 'free'.
      }),
    );
    expect(stale.Item?.lockState).toBe('free');
    expect(harness.staleHits()).toBe(1);

    const fresh = await sim.doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: '_migration_state', sk: 'state' },
        ConsistentRead: true, // simulator passes through; real DDB returns 'apply'.
      }),
    );
    expect(fresh.Item?.lockState).toBe('apply');
    // No new stale hit — ConsistentRead bypassed the simulator.
    expect(harness.staleHits()).toBe(1);
  }, 30_000);

  it('SAFE-PATH MITIGATION: guard wired through framework `readLockRow` (CONSISTENT_READ) correctly throws when the lock is in `apply`, even with the simulator armed', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    // Bootstrap the lock row at lockState='free' first — ElectroDB's `patch()`
    // adds `attribute_exists(pk) AND attribute_exists(sk)` to its
    // ConditionExpression, so `acquireLock` requires the row to already
    // exist (clauses.js patch action lines 621-624). This mimics what `init`
    // does in production.
    const innerService = createMigrationsService(innerClients.doc, tableName);
    await innerService.migrationState
      .put({
        id: 'state',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lockState: 'free',
      })
      .go();
    // Acquire the lock via the framework — ElectroDB writes to the composite
    // key, NOT the literal `_migration_state`. After this, `readLockRow`
    // returns `{lockState: 'apply', ...}` under strong consistency.
    await acquireLock(innerService, baseConfig, { mode: 'apply', migId: 'mig-bld04', runId: 'r-bld04', holder: 'h' });

    // Attach the simulator to the SAME client family used by the
    // internalService (so the framework's reads transit the simulator's
    // middleware stack). The simulator's `!ConsistentRead` gate means the
    // framework's reads (which always carry `consistent: CONSISTENT_READ`)
    // pass through to real DDB.
    const sim = makeDdbLocalClient();
    const harness = attachEventualConsistencyMiddleware(sim.raw, tableName);
    harness.recordWrite({ pk: '_migration_state', sk: 'state', id: 'state', lockState: 'free' });
    harness.beginStaleWindow(10_000);

    const innerServiceUnderSimulator = createMigrationsService(sim.doc, tableName);
    const guardedClients = makeDdbLocalClient();
    const wrapped = wrapClient({ client: guardedClients.doc, config: baseConfig, internalService: innerServiceUnderSimulator }) as typeof guardedClients.doc;

    // The guard's lock-row read goes through `readLockRow` → ElectroDB get
    // with `consistent: CONSISTENT_READ` → underlying GetItem with
    // `ConsistentRead: true` → simulator passes through → real DDB returns
    // `lockState='apply'`. The guard correctly throws.
    await expect(
      wrapped.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: 'user#1', sk: 'profile', name: 'A' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'EDB_MIGRATION_IN_PROGRESS' });

    // The assertion is on the throw, NOT on staleHits — the simulator may
    // have served stale reads on non-lock-row paths (ElectroDB has no other
    // unconditional GetItems on the lock-row key in this flow, so the count
    // should be 0, but that's not what we're testing).
  }, 30_000);
});
