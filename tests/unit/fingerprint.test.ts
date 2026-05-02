import { describe, expect, it } from 'vitest';
import { fingerprint, toCanonicalJSON } from '../../src/core/fingerprint.js';

describe('toCanonicalJSON', () => {
  it('sorts object keys alphabetically', () => {
    expect(toCanonicalJSON({ b: 1, a: 2 })).toBe(toCanonicalJSON({ a: 2, b: 1 }));
  });

  it('sorts nested object keys recursively', () => {
    const a = { outer: { z: 1, a: 2 }, b: 3 };
    const b = { b: 3, outer: { a: 2, z: 1 } };
    expect(toCanonicalJSON(a)).toBe(toCanonicalJSON(b));
  });

  it('strips undefined values', () => {
    expect(toCanonicalJSON({ a: 1, b: undefined })).toBe(toCanonicalJSON({ a: 1 }));
  });

  it('preserves null values', () => {
    const result = toCanonicalJSON({ a: null });
    expect(result).toBe('{"a":null}');
    expect(result).not.toBe(toCanonicalJSON({ a: undefined }));
  });

  it('preserves array element order (arrays are not sorted)', () => {
    const result = toCanonicalJSON({ types: ['string', 'number'] });
    expect(result).toBe('{"types":["string","number"]}');
    expect(result).not.toBe(toCanonicalJSON({ types: ['number', 'string'] }));
  });

  it('handles nested arrays with objects', () => {
    const a = { items: [{ b: 1, a: 2 }] };
    const b = { items: [{ a: 2, b: 1 }] };
    expect(toCanonicalJSON(a)).toBe(toCanonicalJSON(b));
  });

  it('handles primitives directly', () => {
    expect(toCanonicalJSON(42)).toBe('42');
    expect(toCanonicalJSON('hello')).toBe('"hello"');
    expect(toCanonicalJSON(true)).toBe('true');
    expect(toCanonicalJSON(null)).toBe('null');
  });
});

describe('fingerprint', () => {
  it('returns a 64-character hex string (sha256)', () => {
    const result = fingerprint({ type: 'string' });
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across multiple calls with the same input', () => {
    const schema = { attributes: { id: { type: 'string' }, name: { type: 'string' } } };
    expect(fingerprint(schema)).toBe(fingerprint(schema));
  });

  it('is independent of key insertion order', () => {
    const a = { type: 'string', required: true };
    const b = { required: true, type: 'string' };
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('produces different hashes for different schemas', () => {
    expect(fingerprint({ type: 'string' })).not.toBe(fingerprint({ type: 'number' }));
  });

  it('detects added fields', () => {
    expect(fingerprint({ type: 'string' })).not.toBe(
      fingerprint({ type: 'string', required: true }),
    );
  });

  it('detects removed fields', () => {
    expect(fingerprint({ type: 'string', required: true })).not.toBe(
      fingerprint({ type: 'string' }),
    );
  });

  it('detects value changes', () => {
    expect(fingerprint({ version: '1' })).not.toBe(fingerprint({ version: '2' }));
  });

  it('matches a known sha256 value (regression)', () => {
    // Canonical JSON of {"a":1} → sha256 of that string.
    // Verified on first run; locked in to catch any regressions in the hash function.
    const known = fingerprint({ a: 1 });
    expect(known).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
