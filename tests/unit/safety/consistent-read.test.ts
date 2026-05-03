import { describe, expect, it } from 'vitest';
import { CONSISTENT_READ, CONSISTENT_READ_MARKER } from '../../../src/safety/consistent-read.js';

describe('CONSISTENT_READ', () => {
  it('is the literal true', () => {
    expect(CONSISTENT_READ).toBe(true);
  });

  it('is a boolean (type-level guarantee that no consumer can pass `false`)', () => {
    expect(typeof CONSISTENT_READ).toBe('boolean');
  });
});

describe('CONSISTENT_READ_MARKER', () => {
  it('is the documented grep marker string', () => {
    expect(CONSISTENT_READ_MARKER).toBe('@electrodb-migrations/consistent-read');
  });
});
