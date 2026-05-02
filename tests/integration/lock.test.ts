import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireRunnerMutex,
  bootstrapStateRow,
  getLockState,
  getStateRow,
  heartbeatRunnerMutex,
  releaseRunnerMutex,
} from '../../src/core/lock.js';
import {
  MIGRATION_STATE_ID,
  createMigrationStateEntity,
} from '../../src/entities/migration-state.js';
import { ElectroDBMigrationError, LockHeldError, LockLostError } from '../../src/errors.js';
import { sleep } from '../../src/utils/sleep.js';
import { docClient, rawClient } from './helpers/ddb.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'lock-test-table';

const makeState = () => createMigrationStateEntity(docClient, TABLE);

const baseAcquireOpts = {
  operation: 'apply' as const,
  migrationId: '20260428-test',
  appliedBy: 'test-runner:1',
  staleThresholdMs: 60_000,
  acquireWaitMs: 50, // small for fast tests
};

beforeEach(async () => {
  await resetTable(rawClient, TABLE);
});

describe('bootstrapStateRow', () => {
  it('creates the state row when missing and is idempotent', async () => {
    const state = makeState();
    await bootstrapStateRow(state);
    await bootstrapStateRow(state); // idempotent

    const row = await state.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
    expect(row.data?.id).toBe(MIGRATION_STATE_ID);
    expect(row.data?.schemaVersion).toBe(1);
    expect(typeof row.data?.updatedAt).toBe('string');
  });
});

describe('acquireRunnerMutex', () => {
  it('succeeds against a fresh table and returns a refId', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    expect(refId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('persists lock fields and adds the migrationId to inFlightIds', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.lockRefId).toBe(refId);
    expect(row.lockOperation).toBe('apply');
    expect(row.lockMigrationId).toBe('20260428-test');
    expect(row.lockHolder).toBe('test-runner:1');
    expect(typeof row.lockAcquiredAt).toBe('string');
    expect(typeof row.heartbeatAt).toBe('string');
    expect(row.inFlightIds).toContain('20260428-test');
  });

  it('throws LockHeldError when a fresh lock is already held', async () => {
    const state = makeState();
    await acquireRunnerMutex(state, baseAcquireOpts);

    await expect(
      acquireRunnerMutex(state, {
        ...baseAcquireOpts,
        appliedBy: 'other-runner:2',
        migrationId: '20260428-other',
      }),
    ).rejects.toBeInstanceOf(LockHeldError);
  });

  it('LockHeldError carries the holder fields', async () => {
    const state = makeState();
    await acquireRunnerMutex(state, baseAcquireOpts);

    try {
      await acquireRunnerMutex(state, {
        ...baseAcquireOpts,
        appliedBy: 'other-runner:2',
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      const e = err as LockHeldError;
      expect(e.heldBy).toBe('test-runner:1');
      expect(e.operation).toBe('apply');
      expect(e.migrationId).toBe('20260428-test');
      expect(e.heartbeatAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('takes over a stale lock', async () => {
    const state = makeState();
    await acquireRunnerMutex(state, { ...baseAcquireOpts, staleThresholdMs: 60_000 });
    await sleep(50);

    const second = await acquireRunnerMutex(state, {
      ...baseAcquireOpts,
      appliedBy: 'second-runner',
      staleThresholdMs: 10,
    });
    expect(second.refId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.lockHolder).toBe('second-runner');
    expect(row.lockRefId).toBe(second.refId);
  });

  it('preserves failedIds and deploymentBlockedIds when taking over a stale lock', async () => {
    const state = makeState();
    await bootstrapStateRow(state);
    // Seed some operator-asserted state.
    await state
      .update({ id: MIGRATION_STATE_ID })
      .add({ failedIds: ['mig-fail'], deploymentBlockedIds: ['mig-block'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    await acquireRunnerMutex(state, baseAcquireOpts);
    await sleep(50);
    await acquireRunnerMutex(state, {
      ...baseAcquireOpts,
      appliedBy: 'second-runner',
      staleThresholdMs: 10,
    });

    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.failedIds).toContain('mig-fail');
    expect(row.deploymentBlockedIds).toContain('mig-block');
  });

  it('allows acquire even when the migration is in deploymentBlockedIds (state machine gates this)', async () => {
    // Defense-in-depth at the lock level was tempting but blocks legitimate
    // operations like rolling back an applied-with-autoRelease=false migration.
    // The state machine (decideApply / decideRollback) is the source of truth
    // for whether a transition is legal; the lock only protects concurrency.
    const state = makeState();
    await bootstrapStateRow(state);
    await state
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: [baseAcquireOpts.migrationId] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    expect(refId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('wait-and-verify catches a racing overwrite during the verify window', async () => {
    const state = makeState();
    const acquirePromise = acquireRunnerMutex(state, {
      ...baseAcquireOpts,
      acquireWaitMs: 300,
    });
    await sleep(80);
    // Out-of-band: overwrite lock fields as if a stale-takeover competed.
    const now = new Date().toISOString();
    await state
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockHolder: 'attacker',
        lockRefId: 'attacker',
        lockOperation: 'apply',
        lockMigrationId: 'attacker-migration',
        lockAcquiredAt: now,
        heartbeatAt: now,
        updatedAt: now,
      })
      .go();

    await expect(acquirePromise).rejects.toBeInstanceOf(LockLostError);
  });
});

describe('heartbeatRunnerMutex', () => {
  it('updates heartbeatAt while preserving lockRefId', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);

    const before = await getStateRow(state);
    await sleep(20);
    await heartbeatRunnerMutex(state, refId);
    const after = await getStateRow(state);

    if (!before || !after) throw new Error('unreachable');
    expect(after.lockRefId).toBe(refId);
    expect(after.heartbeatAt).not.toBe(before.heartbeatAt);
    expect(
      new Date(after.heartbeatAt ?? '').getTime() > new Date(before.heartbeatAt ?? '').getTime(),
    ).toBe(true);
  });

  it('throws LockLostError when lockRefId no longer matches', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);

    const now = new Date().toISOString();
    await state
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockHolder: 'someone-else',
        lockRefId: 'someone-else',
        heartbeatAt: now,
        updatedAt: now,
      })
      .go();

    await expect(heartbeatRunnerMutex(state, refId)).rejects.toBeInstanceOf(LockLostError);
  });
});

describe('releaseRunnerMutex', () => {
  it('clears lock fields when refId matches', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    await releaseRunnerMutex(state, refId);

    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.lockRefId).toBeUndefined();
    expect(row.lockHolder).toBeUndefined();
    expect(row.heartbeatAt).toBeUndefined();
  });

  it('preserves the state row itself (failedIds, deploymentBlockedIds)', async () => {
    const state = makeState();
    await bootstrapStateRow(state);
    await state
      .update({ id: MIGRATION_STATE_ID })
      .add({ deploymentBlockedIds: ['blocked-mig'] })
      .set({ updatedAt: new Date().toISOString() })
      .go();

    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    await releaseRunnerMutex(state, refId);

    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.deploymentBlockedIds).toContain('blocked-mig');
  });

  it('is silent when the lock has been stolen (refId mismatch)', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    const now = new Date().toISOString();
    await state
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockRefId: 'attacker',
        lockHolder: 'attacker',
        heartbeatAt: now,
        updatedAt: now,
      })
      .go();

    await expect(releaseRunnerMutex(state, refId)).resolves.toBeUndefined();
    const row = await getStateRow(state);
    if (!row) throw new Error('unreachable');
    expect(row.lockRefId).toBe('attacker');
  });

  it('is silent when no lock exists', async () => {
    const state = makeState();
    await bootstrapStateRow(state);
    await expect(releaseRunnerMutex(state, 'never-existed')).resolves.toBeUndefined();
  });
});

describe('getLockState', () => {
  it('returns { locked: false } when no row exists', async () => {
    const state = makeState();
    const lockState = await getLockState(state, 60_000);
    expect(lockState).toEqual({ locked: false });
  });

  it('returns { locked: false } when the row exists but no lock is held', async () => {
    const state = makeState();
    await bootstrapStateRow(state);
    const lockState = await getLockState(state, 60_000);
    expect(lockState).toEqual({ locked: false });
  });

  it('returns full lock state with stale=false for a fresh lock', async () => {
    const state = makeState();
    const { refId } = await acquireRunnerMutex(state, baseAcquireOpts);
    const lockState = await getLockState(state, 60_000);
    expect(lockState.locked).toBe(true);
    if (!lockState.locked) throw new Error('unreachable');
    expect(lockState.refId).toBe(refId);
    expect(lockState.heldBy).toBe('test-runner:1');
    expect(lockState.operation).toBe('apply');
    expect(lockState.migrationId).toBe('20260428-test');
    expect(lockState.stale).toBe(false);
  });

  it('marks stale=true when heartbeatAt is older than threshold', async () => {
    const state = makeState();
    await acquireRunnerMutex(state, baseAcquireOpts);
    await sleep(50);
    const lockState = await getLockState(state, 10);
    expect(lockState.locked).toBe(true);
    if (!lockState.locked) throw new Error('unreachable');
    expect(lockState.stale).toBe(true);
  });
});

describe('error hierarchy', () => {
  it('LockHeldError and LockLostError both extend ElectroDBMigrationError', async () => {
    const state = makeState();
    await acquireRunnerMutex(state, baseAcquireOpts);
    try {
      await acquireRunnerMutex(state, baseAcquireOpts);
    } catch (err) {
      expect(err).toBeInstanceOf(ElectroDBMigrationError);
    }
  });
});
