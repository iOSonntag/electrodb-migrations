import { randomUUID } from 'node:crypto';
import {
  MIGRATION_STATE_ID,
  type MigrationStateEntity,
  STATE_SCHEMA_VERSION,
} from '../entities/migration-state.js';
import { LockHeldError, LockLostError, type LockOperation } from '../errors.js';
import type { MigrationLockState } from '../types.js';
import { sleep } from '../utils/sleep.js';

export type AcquireLockOptions = {
  operation: LockOperation;
  migrationId: string;
  appliedBy: string;
  staleThresholdMs: number;
  acquireWaitMs: number;
};

// Detects ConditionalCheckFailed regardless of how the SDK / ElectroDB wraps it.
// AWS SDK v3 surfaces it as `error.name === 'ConditionalCheckFailedException'`;
// ElectroDB sometimes wraps under `cause`.
export const isConditionalCheckFailed = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; cause?: { name?: string } };
  if (e.name === 'ConditionalCheckFailedException') return true;
  if (e.cause?.name === 'ConditionalCheckFailedException') return true;
  return false;
};

// Idempotent first-time-create of the aggregate state row. Safe to call on
// every acquire — a row that already exists makes this a silent no-op.
export const bootstrapStateRow = async (state: MigrationStateEntity): Promise<void> => {
  try {
    await state
      .create({
        id: MIGRATION_STATE_ID,
        schemaVersion: STATE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      })
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) return; // already bootstrapped
    throw err;
  }
};

// Acquire the global runner mutex by claiming the lock fields on the state row.
//
// Algorithm:
//   1. Bootstrap the state row if missing.
//   2. Conditional update setting our lock fields, gated on:
//      (no current lock OR current heartbeat is stale)
//      AND the migration is not in failedIds (would require rollback first)
//      AND the migration is not in deploymentBlockedIds.
//   3. Sleep acquireWaitMs and re-read with strong consistency to defend
//      against any conditional-write inconsistency in the cluster.
//
// `inFlightIds` accumulates entries via SET ADD; on stale-takeover the prior
// holder's entry stays until reconcileState() runs. The guard does not depend
// on inFlightIds so this is informational, not load-bearing.
export const acquireRunnerMutex = async (
  state: MigrationStateEntity,
  opts: AcquireLockOptions,
): Promise<{ refId: string }> => {
  await bootstrapStateRow(state);

  const refId = randomUUID();
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - opts.staleThresholdMs).toISOString();

  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing is sensitive to inferred entity generics
  const where = (attr: any, op: any): string =>
    `${op.notExists(attr.lockRefId)} OR ${op.lt(attr.heartbeatAt, staleCutoff)}`;

  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .set({
        lockHolder: opts.appliedBy,
        lockRefId: refId,
        lockOperation: opts.operation,
        lockMigrationId: opts.migrationId,
        lockAcquiredAt: now,
        heartbeatAt: now,
        updatedAt: now,
      })
      .add({ inFlightIds: [opts.migrationId] })
      .where(where)
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      // Two possibilities: someone else holds a fresh lock, OR our migrationId
      // is in failedIds / deploymentBlockedIds. Read to disambiguate.
      const existing = await state.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
      throw new LockHeldError({
        heldBy: existing.data?.lockHolder ?? '(unknown)',
        heartbeatAt: existing.data?.heartbeatAt ?? now,
        operation: (existing.data?.lockOperation as LockOperation) ?? opts.operation,
        migrationId: existing.data?.lockMigrationId ?? opts.migrationId,
      });
    }
    throw err;
  }

  await sleep(opts.acquireWaitMs);

  const verify = await state.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
  if (verify.data?.lockRefId !== refId) {
    throw new LockLostError({
      ourRefId: refId,
      currentRefId: verify.data?.lockRefId,
    });
  }

  return { refId };
};

// Updates heartbeatAt only if the row's lockRefId still matches ours.
// Throws LockLostError if another runner has stolen the row.
export const heartbeatRunnerMutex = async (
  state: MigrationStateEntity,
  refId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  // biome-ignore lint/suspicious/noExplicitAny: see acquireRunnerMutex note
  const whereRefMatches = (attr: any, op: any): string => op.eq(attr.lockRefId, refId);
  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .set({ heartbeatAt: now, updatedAt: now })
      .where(whereRefMatches)
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      const existing = await state.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
      throw new LockLostError({
        ourRefId: refId,
        currentRefId: existing.data?.lockRefId,
      });
    }
    throw err;
  }
};

// Clears the lock fields only if our refId still owns them. Silent on mismatch:
// the lock has already moved on, and there's nothing for us to clean up.
//
// Used only on cleanup-on-throw paths — successful lifecycle transitions release
// the mutex transactionally inside the markApplied/markFailed/etc. helpers.
export const releaseRunnerMutex = async (
  state: MigrationStateEntity,
  refId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  // biome-ignore lint/suspicious/noExplicitAny: see acquireRunnerMutex note
  const whereRefMatches = (attr: any, op: any): string => op.eq(attr.lockRefId, refId);
  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .remove([
        'lockHolder',
        'lockRefId',
        'lockAcquiredAt',
        'lockOperation',
        'lockMigrationId',
        'heartbeatAt',
      ])
      .set({ updatedAt: now })
      .where(whereRefMatches)
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) return; // already stolen / already released
    throw err;
  }
};

// The full aggregate row, normalized for downstream consumers.
// Sets are deserialized as arrays by ElectroDB; we keep them as arrays here.
export type StateRow = {
  id: string;
  schemaVersion: number;
  updatedAt: string;
  inFlightIds: string[];
  failedIds: string[];
  deploymentBlockedIds: string[];
  lockHolder?: string;
  lockRefId?: string;
  lockAcquiredAt?: string;
  lockOperation?: LockOperation;
  lockMigrationId?: string;
  heartbeatAt?: string;
};

// Reads the aggregate state row with strong consistency. Returns undefined
// when no row exists yet (pre-bootstrap state).
export const getStateRow = async (state: MigrationStateEntity): Promise<StateRow | undefined> => {
  const row = await state.get({ id: MIGRATION_STATE_ID }).go({ consistent: true });
  if (!row.data) return undefined;
  const d = row.data;
  return {
    id: d.id,
    schemaVersion: d.schemaVersion,
    updatedAt: d.updatedAt,
    inFlightIds: (d.inFlightIds as string[] | undefined) ?? [],
    failedIds: (d.failedIds as string[] | undefined) ?? [],
    deploymentBlockedIds: (d.deploymentBlockedIds as string[] | undefined) ?? [],
    ...(d.lockHolder !== undefined ? { lockHolder: d.lockHolder } : {}),
    ...(d.lockRefId !== undefined ? { lockRefId: d.lockRefId } : {}),
    ...(d.lockAcquiredAt !== undefined ? { lockAcquiredAt: d.lockAcquiredAt } : {}),
    ...(d.lockOperation !== undefined ? { lockOperation: d.lockOperation as LockOperation } : {}),
    ...(d.lockMigrationId !== undefined ? { lockMigrationId: d.lockMigrationId } : {}),
    ...(d.heartbeatAt !== undefined ? { heartbeatAt: d.heartbeatAt } : {}),
  };
};

// Derives the public MigrationLockState view from the aggregate row.
// Used by client.getLockState() and as a building block for getGuardState().
export const getLockState = async (
  state: MigrationStateEntity,
  staleThresholdMs: number,
): Promise<MigrationLockState> => {
  const row = await getStateRow(state);
  if (!row || row.lockRefId === undefined) return { locked: false };

  const heartbeatAt = row.heartbeatAt ?? row.lockAcquiredAt ?? new Date(0).toISOString();
  const heartbeatMs = new Date(heartbeatAt).getTime();
  const stale = Date.now() - heartbeatMs > staleThresholdMs;

  return {
    locked: true,
    stale,
    heldBy: row.lockHolder ?? '(unknown)',
    operation: row.lockOperation ?? 'apply',
    migrationId: row.lockMigrationId ?? '(unknown)',
    acquiredAt: row.lockAcquiredAt ?? heartbeatAt,
    heartbeatAt,
    refId: row.lockRefId,
  };
};
