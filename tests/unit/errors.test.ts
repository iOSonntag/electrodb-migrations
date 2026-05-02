import { describe, expect, it } from 'vitest';
import {
  ElectroDBMigrationError,
  FingerprintMismatchError,
  LockHeldError,
  LockLostError,
  MigrationFailedError,
  MigrationInProgressError,
  RequiresRollbackError,
  RollbackNotPossibleError,
} from '../../src/errors.js';

describe('ElectroDBMigrationError', () => {
  it('is a subclass of Error', () => {
    const err = new ElectroDBMigrationError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('ElectroDBMigrationError');
  });

  it('preserves cause when passed', () => {
    const cause = new Error('root');
    const err = new ElectroDBMigrationError('wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('LockHeldError', () => {
  it('extends ElectroDBMigrationError and carries lock-holder fields', () => {
    const err = new LockHeldError({
      heldBy: 'host-a:123',
      heartbeatAt: '2026-04-28T10:00:00.000Z',
      operation: 'apply',
      migrationId: '20260428-add-status',
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err).toBeInstanceOf(LockHeldError);
    expect(err.name).toBe('LockHeldError');
    expect(err.heldBy).toBe('host-a:123');
    expect(err.heartbeatAt).toBe('2026-04-28T10:00:00.000Z');
    expect(err.operation).toBe('apply');
    expect(err.migrationId).toBe('20260428-add-status');
  });
});

describe('LockLostError', () => {
  it('captures both refIds for diagnosis', () => {
    const err = new LockLostError({
      ourRefId: 'aaa-111',
      currentRefId: 'bbb-222',
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err.name).toBe('LockLostError');
    expect(err.ourRefId).toBe('aaa-111');
    expect(err.currentRefId).toBe('bbb-222');
  });

  it('handles a missing currentRefId (lock cleared mid-wait)', () => {
    const err = new LockLostError({ ourRefId: 'aaa', currentRefId: undefined });
    expect(err.currentRefId).toBeUndefined();
  });
});

describe('RequiresRollbackError', () => {
  it('carries migrationId and currentStatus', () => {
    const err = new RequiresRollbackError({
      migrationId: '20260428-add-status',
      currentStatus: 'failed',
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err.name).toBe('RequiresRollbackError');
    expect(err.migrationId).toBe('20260428-add-status');
    expect(err.currentStatus).toBe('failed');
  });
});

describe('RollbackNotPossibleError', () => {
  it('carries reason discriminator', () => {
    const err = new RollbackNotPossibleError({
      migrationId: 'abc',
      reason: 'no-down-fn',
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err.name).toBe('RollbackNotPossibleError');
    expect(err.reason).toBe('no-down-fn');
  });

  it('accepts already-reverted reason', () => {
    const err = new RollbackNotPossibleError({
      migrationId: 'abc',
      reason: 'already-reverted',
    });
    expect(err.reason).toBe('already-reverted');
  });
});

describe('FingerprintMismatchError', () => {
  it('captures expected vs actual', () => {
    const err = new FingerprintMismatchError({
      migrationId: 'abc',
      expected: 'sha-1',
      actual: 'sha-2',
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err.name).toBe('FingerprintMismatchError');
    expect(err.expected).toBe('sha-1');
    expect(err.actual).toBe('sha-2');
  });
});

describe('MigrationFailedError', () => {
  it('wraps an underlying cause and exposes migrationId', () => {
    const cause = new Error('DDB throttled');
    const err = new MigrationFailedError({
      migrationId: '20260428-add-status',
      cause,
    });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err.name).toBe('MigrationFailedError');
    expect(err.migrationId).toBe('20260428-add-status');
    expect(err.cause).toBe(cause);
  });
});

describe('MigrationInProgressError', () => {
  it('extends ElectroDBMigrationError', () => {
    const err = new MigrationInProgressError({ reasons: ['locked'] });
    expect(err).toBeInstanceOf(ElectroDBMigrationError);
    expect(err).toBeInstanceOf(MigrationInProgressError);
    expect(err.name).toBe('MigrationInProgressError');
  });

  it('carries lock context with reasons=[locked]', () => {
    const lock = {
      locked: true as const,
      stale: false,
      heldBy: 'host:1',
      operation: 'apply' as const,
      migrationId: 'm1',
      acquiredAt: '2026-04-30T00:00:00.000Z',
      heartbeatAt: '2026-04-30T00:00:01.000Z',
      refId: 'r1',
    };
    const err = new MigrationInProgressError({ reasons: ['locked'], lock });
    expect(err.reasons).toEqual(['locked']);
    expect(err.lock).toEqual(lock);
    expect(err.failedMigrations).toBeUndefined();
    expect(err.deploymentBlockedIds).toBeUndefined();
    expect(err.isReason('locked')).toBe(true);
    expect(err.isReason('failed-migration')).toBe(false);
  });

  it('carries failedMigrations with reasons=[failed-migration]', () => {
    const failed = [{ id: 'm1', error: 'boom' }, { id: 'm2' }];
    const err = new MigrationInProgressError({
      reasons: ['failed-migration'],
      failedMigrations: failed,
    });
    expect(err.reasons).toEqual(['failed-migration']);
    expect(err.failedMigrations).toEqual(failed);
    expect(err.lock).toBeUndefined();
    expect(err.isReason('failed-migration')).toBe(true);
  });

  it('carries deploymentBlockedIds with reasons=[deployment-block]', () => {
    const err = new MigrationInProgressError({
      reasons: ['deployment-block'],
      deploymentBlockedIds: ['m1', 'm2'],
    });
    expect(err.reasons).toEqual(['deployment-block']);
    expect(err.deploymentBlockedIds).toEqual(['m1', 'm2']);
    expect(err.isReason('deployment-block')).toBe(true);
  });

  it('combines all three reasons with all payloads', () => {
    const lock = {
      locked: true as const,
      stale: false,
      heldBy: 'host:1',
      operation: 'finalize' as const,
      migrationId: 'm1',
      acquiredAt: '2026-04-30T00:00:00.000Z',
      heartbeatAt: '2026-04-30T00:00:01.000Z',
      refId: 'r1',
    };
    const failed = [{ id: 'm0' }];
    const err = new MigrationInProgressError({
      reasons: ['locked', 'failed-migration', 'deployment-block'],
      lock,
      failedMigrations: failed,
      deploymentBlockedIds: ['m2'],
    });
    expect(err.reasons).toEqual(['locked', 'failed-migration', 'deployment-block']);
    expect(err.lock).toEqual(lock);
    expect(err.failedMigrations).toEqual(failed);
    expect(err.deploymentBlockedIds).toEqual(['m2']);
    expect(err.isReason('locked')).toBe(true);
    expect(err.isReason('failed-migration')).toBe(true);
    expect(err.isReason('deployment-block')).toBe(true);
  });

  it('carries cause for reason=guard-check-failed', () => {
    const cause = new Error('DDB unreachable');
    const err = new MigrationInProgressError({ reason: 'guard-check-failed', cause });
    expect(err.reason).toBe('guard-check-failed');
    expect(err.cause).toBe(cause);
    expect(err.reasons).toBeUndefined();
    expect(err.isReason('locked')).toBe(false);
  });
});
