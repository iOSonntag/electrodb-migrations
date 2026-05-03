import { describe, expect, it } from 'vitest';
import { EDBMigrationError } from '../../../src/errors/base.js';
import {
  EDBMigrationInProgressError,
  EDBMigrationLockHeldError,
  EDBRequiresRollbackError,
  EDBRollbackNotPossibleError,
  EDBRollbackOutOfOrderError,
  EDBSelfReadInMigrationError,
  EDBStaleEntityReadError,
} from '../../../src/errors/classes.js';
import { ERROR_CODES } from '../../../src/errors/codes.js';

describe('ERR-02..08 concrete subclasses', () => {
  const cases: Array<[string, new (m: string) => EDBMigrationError, string]> = [
    ['lock held', EDBMigrationLockHeldError, ERROR_CODES.LOCK_HELD],
    ['migration in progress', EDBMigrationInProgressError, ERROR_CODES.MIGRATION_IN_PROGRESS],
    ['requires rollback', EDBRequiresRollbackError, ERROR_CODES.REQUIRES_ROLLBACK],
    ['rollback not possible', EDBRollbackNotPossibleError, ERROR_CODES.ROLLBACK_NOT_POSSIBLE],
    ['out of order', EDBRollbackOutOfOrderError, ERROR_CODES.ROLLBACK_OUT_OF_ORDER],
    ['stale entity', EDBStaleEntityReadError, ERROR_CODES.STALE_ENTITY_READ],
    ['self read', EDBSelfReadInMigrationError, ERROR_CODES.SELF_READ_IN_MIGRATION],
  ];

  for (const [label, Cls, expectedCode] of cases) {
    it(`${label}: code matches ERROR_CODES + extends EDBMigrationError + name set`, () => {
      const err = new Cls('boom');
      expect(err.code).toBe(expectedCode);
      expect(err).toBeInstanceOf(EDBMigrationError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(Cls.name);
      expect(err.message).toBe('boom');
    });
  }

  it('rollback not possible carries reason in details', () => {
    const err = new EDBRollbackNotPossibleError('cannot rollback', { reason: 'no-down-fn' });
    expect(err.details).toEqual({ reason: 'no-down-fn' });
  });
});
