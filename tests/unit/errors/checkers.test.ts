import { describe, expect, it } from 'vitest';
import { isMigrationInProgress } from '../../../src/errors/checkers.js';
import { EDBMigrationInProgressError, EDBMigrationLockHeldError } from '../../../src/errors/classes.js';

describe('isMigrationInProgress', () => {
  it('returns true for a fresh EDBMigrationInProgressError', () => {
    expect(isMigrationInProgress(new EDBMigrationInProgressError('blocked'))).toBe(true);
  });

  it('returns true for a plain object with the right code (dual-package safety)', () => {
    expect(isMigrationInProgress({ code: 'EDB_MIGRATION_IN_PROGRESS' })).toBe(true);
  });

  it('returns true for a frozen object with the right code', () => {
    const o = Object.freeze({ code: 'EDB_MIGRATION_IN_PROGRESS', message: 'x', details: {} });
    expect(isMigrationInProgress(o)).toBe(true);
  });

  it('returns false for a different EDB error class', () => {
    expect(isMigrationInProgress(new EDBMigrationLockHeldError('x'))).toBe(false);
  });

  it('returns false for null, undefined, and primitives', () => {
    expect(isMigrationInProgress(null)).toBe(false);
    expect(isMigrationInProgress(undefined)).toBe(false);
    expect(isMigrationInProgress(42)).toBe(false);
    expect(isMigrationInProgress('EDB_MIGRATION_IN_PROGRESS')).toBe(false);
  });

  it('returns false for the typo variant (Pitfall #8 guard)', () => {
    // 'EDB_MIGRATIONS_IN_PROGRESS' — note the extra S; must NOT match.
    expect(isMigrationInProgress({ code: 'EDB_MIGRATIONS_IN_PROGRESS' })).toBe(false);
  });

  it('returns false for plain Error', () => {
    expect(isMigrationInProgress(new Error('boom'))).toBe(false);
  });
});
