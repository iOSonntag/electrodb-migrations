import { describe, expect, it } from 'vitest';
import { computeIntegrityHash } from '../../../src/scaffold/integrity-hash.js';

describe('computeIntegrityHash', () => {
  it('returns the well-known SHA-256 of "hello" with the sha256: prefix', () => {
    expect(computeIntegrityHash('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is deterministic across multiple invocations on the same input', () => {
    const a = computeIntegrityHash('hello');
    const b = computeIntegrityHash('hello');
    expect(a).toBe(b);
  });

  it('produces different output for different inputs', () => {
    expect(computeIntegrityHash('hello')).not.toBe(computeIntegrityHash('world'));
  });

  it('treats Buffer input as equivalent to its UTF-8 string form', () => {
    const fromString = computeIntegrityHash('hello');
    const fromBuffer = computeIntegrityHash(Buffer.from('hello', 'utf8'));
    expect(fromString).toBe(fromBuffer);
  });

  it('returns the well-known SHA-256 of the empty input', () => {
    expect(computeIntegrityHash('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
