/**
 * LCK-06 — `acquireLock(mode='finalize')` writes `lockState='finalize'`.
 *
 * The `finalize` lockState is one of the four ACTIVE states (alongside
 * `apply`, `rollback`, `dying`) — the heartbeat is maintained, and stale-
 * takeover applies. This test only verifies the write side: `mode='finalize'`
 * lands `lockState='finalize'` on disk.
 *
 * NOT verified here: guard-side traffic gating during finalize. WAVE0-NOTES
 * Decision A7 documents that `finalize` is INTENTIONALLY excluded from
 * `GATING_LOCK_STATES` (README §1 wins over GRD-04 wording). Plan 03-07
 * exercises the guard side via the eventual-consistency simulator.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock, readLockRow } from '../../../src/lock/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

const baseConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 1_000 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
} as never;

describe('LCK-06: finalize uses lockState="finalize"', () => {
  const tableName = randomTableName('lck-06');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('acquireLock with mode="finalize" writes lockState="finalize"', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const service = createMigrationsService(doc, tableName);
    await acquireLock(service, baseConfig, { mode: 'finalize', migId: 'mig-fin', runId: 'r-fin', holder: 'h' });
    const row = await readLockRow(service);
    expect(row?.lockState).toBe('finalize');
    expect(row?.lockRunId).toBe('r-fin');
    expect(row?.lockMigrationId).toBe('mig-fin');
    expect(row?.lockHolder).toBe('h');
  }, 15_000);
});
