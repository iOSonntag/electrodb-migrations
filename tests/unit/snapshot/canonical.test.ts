import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../src/snapshot/canonical.js';

describe('canonicalJson', () => {
  it('produces the same output for two object literals with reordered keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('recursively sorts nested object keys', () => {
    const out = canonicalJson({ z: { y: 1, x: 2 }, a: 1 });
    expect(out).toBe('{"a":1,"z":{"x":2,"y":1}}');
  });

  it('preserves array element order (positional semantics)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializes primitives via JSON.stringify semantics', () => {
    expect(canonicalJson('hello')).toBe('"hello"');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('throws when given a Date', () => {
    expect(() => canonicalJson(new Date())).toThrow(/non-plain-object/);
  });

  it('throws when given a Map or Set', () => {
    expect(() => canonicalJson(new Map())).toThrow(/non-plain-object/);
    expect(() => canonicalJson(new Set())).toThrow(/non-plain-object/);
  });

  it('throws when given a class instance', () => {
    class Foo {}
    expect(() => canonicalJson(new Foo())).toThrow(/non-plain-object/);
  });

  it('is deterministic across multiple invocations on the same fixture', () => {
    const fixture = {
      attributes: { id: { type: 'string', required: true }, email: { type: 'string', required: true } },
      indexes: { byId: { pk: { field: 'pk', composite: ['id'] } } },
    };
    const baseline = canonicalJson(fixture);
    for (let i = 0; i < 10; i += 1) {
      expect(canonicalJson(fixture)).toBe(baseline);
    }
  });

  it('handles empty objects and arrays', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});
