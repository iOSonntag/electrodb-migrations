/**
 * API-05 + LCK-08 — client.forceUnlock() integration tests against DDB Local.
 *
 * Mirrors `tests/integration/lock/unlock-state-aware.test.ts` but exercises
 * the path via `createMigrationsClient(...).forceUnlock(...)` instead of the
 * lib function directly.
 *
 * LCK-08 truth table (tested here via the client surface):
 *
 * | priorState                                | action                              |
 * |-------------------------------------------|-------------------------------------|
 * | `apply`, `rollback`, `finalize`, `dying`  | markFailed → lockState='failed'     |
 * | `release`, `failed`                       | forced clear → lockState='free'     |
 * | `free`                                    | no-op; returns priorState='free'    |
 *
 * Additional BLOCKER 2 cases:
 * - `yes` omitted → rejects with EDBUnlockRequiresConfirmationError BEFORE any DDB I/O.
 * - `yes: false` → same rejection.
 *
 * Each case uses its own ephemeral table for isolation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { acquireLock, readLockRow } from '../../../src/lock/index.js';
import { MIGRATION_STATE_ID, STATE_SCHEMA_VERSION, createMigrationsService } from '../../../src/internal-entities/index.js';
import { EDBUnlockRequiresConfirmationError } from '../../../src/errors/index.js';
import {
  bootstrapMigrationState,
  createTestTable,
  deleteTestTable,
  isDdbLocalReachable,
  makeDdbLocalClient,
  randomTableName,
  skipMessage,
} from '../_helpers/index.js';

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  entities: [],
  migrations: 'src/database/migrations',
  region: undefined,
  tableName: '',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// LCK-08 active states: apply, rollback, finalize, dying → forceUnlock → 'failed'
// ---------------------------------------------------------------------------

for (const activeState of ['apply', 'rollback', 'finalize', 'dying'] as const) {
  describe(`client.forceUnlock() — lockState='${activeState}' → 'failed'`, () => {
    let alive = false;
    let tableName: string;
    const { raw, doc } = makeDdbLocalClient();

    beforeAll(async () => {
      alive = await isDdbLocalReachable();
      if (!alive) return;

      tableName = randomTableName(`cfu-${activeState}`);
      await createTestTable(raw, tableName);
      await bootstrapMigrationState(doc, tableName);
      const service = createMigrationsService(doc, tableName);

      // Seed via acquireLock(mode='apply') to get the correct row layout
      await acquireLock(service, testConfig, {
        mode: 'apply',
        migId: `mig-${activeState}`,
        runId: `r-${activeState}`,
        holder: 'test-host',
      });

      // Patch lockState to the target if different from 'apply'
      if (activeState !== 'apply') {
        await service.migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: activeState }).go();
      }
    }, 30_000);

    afterAll(async () => {
      if (alive) {
        await deleteTestTable(raw, tableName);
      }
    });

    it(`forceUnlock with yes:true on '${activeState}' returns priorState='${activeState}'; lock→'failed'`, async () => {
      if (!alive) {
        console.warn(skipMessage());
        return;
      }

      const client = createMigrationsClient({
        config: testConfig,
        client: doc,
        tableName,
      });

      const result = await client.forceUnlock({ runId: `r-${activeState}`, yes: true });

      expect(result.priorState).toBe(activeState);

      const lockRow = await runUnguarded(() => {
        const service = createMigrationsService(doc, tableName);
        return readLockRow(service);
      });
      expect(lockRow?.lockState).toBe('failed');
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// LCK-08 cleared states: release, failed → forceUnlock → 'free'
// ---------------------------------------------------------------------------

for (const clearedState of ['release', 'failed'] as const) {
  describe(`client.forceUnlock() — lockState='${clearedState}' → 'free'`, () => {
    let alive = false;
    let tableName: string;
    const { raw, doc } = makeDdbLocalClient();

    beforeAll(async () => {
      alive = await isDdbLocalReachable();
      if (!alive) return;

      tableName = randomTableName(`cfu-${clearedState}`);
      await createTestTable(raw, tableName);
      const service = createMigrationsService(doc, tableName);
      const now = new Date().toISOString();

      // Write the lock row directly (no production path to these states without prior lock)
      await service.migrationState
        .put({
          id: MIGRATION_STATE_ID,
          schemaVersion: STATE_SCHEMA_VERSION,
          updatedAt: now,
          lockState: clearedState,
          lockRunId: `r-${clearedState}`,
          lockHolder: 'test-host',
        })
        .go();
    }, 30_000);

    afterAll(async () => {
      if (alive) {
        await deleteTestTable(raw, tableName);
      }
    });

    it(`forceUnlock with yes:true on '${clearedState}' returns priorState='${clearedState}'; lock→'free'`, async () => {
      if (!alive) {
        console.warn(skipMessage());
        return;
      }

      const client = createMigrationsClient({
        config: testConfig,
        client: doc,
        tableName,
      });

      const result = await client.forceUnlock({ runId: `r-${clearedState}`, yes: true });

      expect(result.priorState).toBe(clearedState);

      const lockRow = await runUnguarded(() => {
        const service = createMigrationsService(doc, tableName);
        return readLockRow(service);
      });
      expect(lockRow?.lockState).toBe('free');
    }, 30_000);
  });
}

// ---------------------------------------------------------------------------
// LCK-08 free state: no-op
// ---------------------------------------------------------------------------

describe("client.forceUnlock() — lockState='free' → no-op", () => {
  let alive = false;
  let tableName: string;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('cfu-free');
    await createTestTable(raw, tableName);
    // No bootstrapMigrationState — row should not exist
  }, 30_000);

  afterAll(async () => {
    if (alive) {
      await deleteTestTable(raw, tableName);
    }
  });

  it("forceUnlock with yes:true on 'free' (no lock row) returns priorState='free'; row unchanged", async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: doc,
      tableName,
    });

    const result = await client.forceUnlock({ runId: 'never-existed', yes: true });
    expect(result.priorState).toBe('free');

    // Lock row should not exist (forceUnlock did not create one)
    const lockRow = await runUnguarded(() => {
      const service = createMigrationsService(doc, tableName);
      return readLockRow(service);
    });
    expect(lockRow).toBeNull();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// client.getLockState() sanity check
// ---------------------------------------------------------------------------

describe('client.getLockState() — returns LockRowSnapshot shape', () => {
  let alive = false;
  let tableName: string;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('clu-lockstate');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) {
      await deleteTestTable(raw, tableName);
    }
  });

  it('getLockState() returns the lock row after bootstrapMigrationState', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: doc,
      tableName,
    });

    const lockRow = await client.getLockState();

    // bootstrapMigrationState writes lockState='free'
    expect(lockRow).not.toBeNull();
    expect(lockRow?.lockState).toBe('free');
    expect(lockRow?.id).toBe('state');
    expect(typeof lockRow?.schemaVersion).toBe('number');
    expect(typeof lockRow?.updatedAt).toBe('string');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — yes-flag rejection at integration level (no DDB I/O)
// ---------------------------------------------------------------------------

describe('client.forceUnlock() — BLOCKER 2: yes flag rejection', () => {
  let alive = false;
  let tableName: string;
  const { raw, doc } = makeDdbLocalClient();

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    tableName = randomTableName('cfu-blocker2');
    await createTestTable(raw, tableName);
    await bootstrapMigrationState(doc, tableName);

    // Set up a lock row in 'apply' state so we can verify it is UNCHANGED after rejection
    const service = createMigrationsService(doc, tableName);
    await acquireLock(service, testConfig, {
      mode: 'apply',
      migId: 'mig-blocker2',
      runId: 'run-blocker2',
      holder: 'test-host',
    });
  }, 30_000);

  afterAll(async () => {
    if (alive) {
      await deleteTestTable(raw, tableName);
    }
  });

  it('forceUnlock({runId}) without yes rejects with EDBUnlockRequiresConfirmationError; lock row unchanged', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: doc,
      tableName,
    });

    // Rejection path — no yes
    await expect(client.forceUnlock({ runId: 'run-blocker2' })).rejects.toBeInstanceOf(
      EDBUnlockRequiresConfirmationError,
    );

    // Lock row must be UNCHANGED — still in 'apply' state (no DDB write happened)
    const lockRow = await runUnguarded(() => {
      const service = createMigrationsService(doc, tableName);
      return readLockRow(service);
    });
    expect(lockRow?.lockState).toBe('apply');
  }, 15_000);

  it('forceUnlock({runId, yes: false}) rejects with EDBUnlockRequiresConfirmationError; lock row unchanged', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: doc,
      tableName,
    });

    // Rejection path — yes: false
    await expect(client.forceUnlock({ runId: 'run-blocker2', yes: false })).rejects.toBeInstanceOf(
      EDBUnlockRequiresConfirmationError,
    );

    // Lock row must STILL be in 'apply' state
    const lockRow = await runUnguarded(() => {
      const service = createMigrationsService(doc, tableName);
      return readLockRow(service);
    });
    expect(lockRow?.lockState).toBe('apply');
  }, 15_000);
});
