import type { MigrationBlockReason, MigrationLockState, MigrationStatus } from './types.js';

// Base class for everything this library throws on its own behalf.
// ElectroDB's own errors propagate unchanged (or wrapped via `cause`)
// so callers can `instanceof ElectroError` for DDB-layer concerns and
// `instanceof ElectroDBMigrationError` for lifecycle concerns.
export class ElectroDBMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ElectroDBMigrationError';
  }
}

export type LockOperation = 'apply' | 'finalize' | 'rollback';

export class LockHeldError extends ElectroDBMigrationError {
  readonly heldBy: string;
  readonly heartbeatAt: string;
  readonly operation: LockOperation;
  readonly migrationId: string;

  constructor(fields: {
    heldBy: string;
    heartbeatAt: string;
    operation: LockOperation;
    migrationId: string;
  }) {
    super(
      `Migration lock is held by ${fields.heldBy} (operation=${fields.operation}, migrationId=${fields.migrationId}, heartbeatAt=${fields.heartbeatAt})`,
    );
    this.name = 'LockHeldError';
    this.heldBy = fields.heldBy;
    this.heartbeatAt = fields.heartbeatAt;
    this.operation = fields.operation;
    this.migrationId = fields.migrationId;
  }
}

// Raised when the post-acquire wait-and-verify saw a different refId
// than the one we wrote — another runner stole the lock during our
// verification window.
export class LockLostError extends ElectroDBMigrationError {
  readonly ourRefId: string;
  readonly currentRefId: string | undefined;

  constructor(fields: { ourRefId: string; currentRefId: string | undefined }) {
    super(
      `Migration lock lost during verify: ours=${fields.ourRefId}, current=${fields.currentRefId ?? '(none)'}`,
    );
    this.name = 'LockLostError';
    this.ourRefId = fields.ourRefId;
    this.currentRefId = fields.currentRefId;
  }
}

export class RequiresRollbackError extends ElectroDBMigrationError {
  readonly migrationId: string;
  readonly currentStatus: MigrationStatus;

  constructor(fields: { migrationId: string; currentStatus: MigrationStatus }) {
    super(
      `Migration ${fields.migrationId} is in status=${fields.currentStatus}; rollback required before re-applying`,
    );
    this.name = 'RequiresRollbackError';
    this.migrationId = fields.migrationId;
    this.currentStatus = fields.currentStatus;
  }
}

export type RollbackNotPossibleReason = 'no-down-fn' | 'already-reverted';

export class RollbackNotPossibleError extends ElectroDBMigrationError {
  readonly migrationId: string;
  readonly reason: RollbackNotPossibleReason;

  constructor(fields: { migrationId: string; reason: RollbackNotPossibleReason }) {
    super(`Cannot rollback migration ${fields.migrationId}: ${fields.reason}`);
    this.name = 'RollbackNotPossibleError';
    this.migrationId = fields.migrationId;
    this.reason = fields.reason;
  }
}

export class FingerprintMismatchError extends ElectroDBMigrationError {
  readonly migrationId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(fields: { migrationId: string; expected: string; actual: string }) {
    super(
      `Schema fingerprint drift on migration ${fields.migrationId}: expected=${fields.expected}, actual=${fields.actual}`,
    );
    this.name = 'FingerprintMismatchError';
    this.migrationId = fields.migrationId;
    this.expected = fields.expected;
    this.actual = fields.actual;
  }
}

export class MigrationFailedError extends ElectroDBMigrationError {
  readonly migrationId: string;

  constructor(fields: { migrationId: string; cause: unknown }) {
    super(`Migration ${fields.migrationId} failed`, { cause: fields.cause });
    this.name = 'MigrationFailedError';
    this.migrationId = fields.migrationId;
  }
}

type ActiveLock = Extract<MigrationLockState, { locked: true }>;
export type FailedMigrationSummary = { id: string; error?: string };

// Raised by the wrap-client guard middleware. Two shapes:
//   1. Block conditions matched: `reasons[]` has the set of triggering
//      conditions (locked, failed-migration, deployment-block), each with
//      its own optional payload.
//   2. The guard fetch itself failed under failureMode='closed': single
//      `reason: 'guard-check-failed'` with the underlying cause.
export type MigrationInProgressFields =
  | {
      reasons: MigrationBlockReason[];
      lock?: ActiveLock;
      failedMigrations?: FailedMigrationSummary[];
      deploymentBlockedIds?: string[];
    }
  | { reason: 'guard-check-failed'; cause: unknown };

export class MigrationInProgressError extends ElectroDBMigrationError {
  readonly reasons?: MigrationBlockReason[];
  readonly reason?: 'guard-check-failed';
  readonly lock?: ActiveLock;
  readonly failedMigrations?: FailedMigrationSummary[];
  readonly deploymentBlockedIds?: string[];

  constructor(fields: MigrationInProgressFields) {
    super(messageFor(fields), 'cause' in fields ? { cause: fields.cause } : undefined);
    this.name = 'MigrationInProgressError';
    if ('reasons' in fields) {
      this.reasons = fields.reasons;
      if (fields.lock) this.lock = fields.lock;
      if (fields.failedMigrations) this.failedMigrations = fields.failedMigrations;
      if (fields.deploymentBlockedIds) this.deploymentBlockedIds = fields.deploymentBlockedIds;
    } else {
      this.reason = fields.reason;
    }
  }

  // Convenience predicate: did this block fire because of `r`?
  isReason(r: MigrationBlockReason): boolean {
    return this.reasons?.includes(r) ?? false;
  }
}

const messageFor = (fields: MigrationInProgressFields): string => {
  if ('reason' in fields) return 'Migration guard check failed';
  return `Migration in progress (${fields.reasons.join(', ')})`;
};
