import { describe, expect, it } from 'vitest';
import { EDBMigrationError } from '../../../src/errors/base.js';

class TestError extends EDBMigrationError {
  readonly code = 'EDB_TEST' as const;
}

describe('EDBMigrationError', () => {
  it('captures message via super(message)', () => {
    const err = new TestError('something broke');
    expect(err.message).toBe('something broke');
  });

  it('sets name to the subclass constructor name (via new.target)', () => {
    const err = new TestError('x');
    expect(err.name).toBe('TestError');
  });

  it('freezes details so callers cannot mutate after construction', () => {
    const err = new TestError('x', { foo: 1 });
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(err.details).toEqual({ foo: 1 });
  });

  it('defaults details to a frozen empty object when omitted', () => {
    const err = new TestError('x');
    expect(err.details).toEqual({});
    expect(Object.isFrozen(err.details)).toBe(true);
  });

  it('subclass code is readable via err.code', () => {
    const err = new TestError('x');
    expect(err.code).toBe('EDB_TEST');
  });

  it('is an instance of Error (for stack traces and SDK interop)', () => {
    const err = new TestError('x');
    expect(err).toBeInstanceOf(Error);
  });
});
