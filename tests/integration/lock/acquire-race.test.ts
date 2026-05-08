/**
 * LCK-01 — concurrent `acquireLock` race against a real DDB Local table.
 *
 * Proves the load-bearing safety invariant: N parallel acquire attempts against
 * the same lock row produce EXACTLY ONE winner; the other N-1 throw
 * {@link EDBMigrationLockHeldError}. The conditional-write at the heart of
 * `state-mutations.acquire` carries the entire correctness story — without
 * this test, a Phase 4 implementation could regress that ConditionExpression
 * and never know.
 *
 * Uses `raceAcquires` from Plan 01's `_helpers/concurrent-acquire.ts` which
 * wraps `Promise.allSettled` so a single rejection does not unwind the rest
 * of the race.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../../src/errors/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, raceAcquires, randomTableName, skipMessage } from '../_helpers/index.js';

// `as never` cast: tests synthesize a partial ResolvedConfig — only the lock
// + guard tunings are read by the orchestrators under test. The full config
// surface (entities, migrations, runner, remote, ...) is irrelevant to the
// integration scenarios in this file.
const baseConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 15_000 },
  guard: { cacheTtlMs: 5_000, blockMode: 'all' as const },
} as never;

describe('LCK-01: concurrent acquireLock — exactly one winner', () => {
  const tableName = randomTableName('lck-01-race');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('5 parallel acquireLock calls produce exactly 1 winner; 4 losers throw EDBMigrationLockHeldError', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const service = createMigrationsService(doc, tableName);
    const attempts = Array.from(
      { length: 5 },
      (_, i) => () =>
        acquireLock(service, baseConfig, {
          mode: 'apply',
          migId: 'mig-race',
          runId: `r-${i}-${randomUUID()}`,
          holder: `host-${i}`,
        }),
    );
    const { winners, losers } = await raceAcquires(attempts);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) {
      // Plan 03-03 deviation #4 — actual error code is EDB_MIGRATION_LOCK_HELD;
      // the constant in src/errors/codes.ts is the single source of truth.
      expect((loser.reason as { code?: string }).code).toBe(ERROR_CODES.LOCK_HELD);
    }
  }, 60_000);
});
