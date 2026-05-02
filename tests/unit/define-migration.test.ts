import type { Entity } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { defineMigration } from '../../src/core/define-migration.js';

// Cast helpers — defineMigration is an identity function at runtime;
// the TypeScript generics are what matter, not the actual entity instances.
// biome-ignore lint/suspicious/noExplicitAny: mock cast for structural test — type correctness is verified by the compiler, not at runtime
const mockFrom = {} as Entity<any, any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: same as above
const mockTo = {} as Entity<any, any, any, any>;
const up = async (item: unknown) => item;

describe('defineMigration', () => {
  it('returns the exact same object reference', () => {
    const def = { id: 'test', entityName: 'Test', from: mockFrom, to: mockTo, up };
    // biome-ignore lint/suspicious/noExplicitAny: bypassing strict generic resolution for structural test
    const result = defineMigration(def as any);
    expect(result).toBe(def);
  });

  it('preserves all required fields', () => {
    const def = { id: '20260101-test', entityName: 'User', from: mockFrom, to: mockTo, up };
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    const result = defineMigration(def as any);
    expect(result.id).toBe('20260101-test');
    expect(result.entityName).toBe('User');
    expect(result.from).toBe(mockFrom);
    expect(result.to).toBe(mockTo);
    expect(result.up).toBe(up);
  });

  it('has no down property when down is omitted', () => {
    const def = { id: 'test', entityName: 'User', from: mockFrom, to: mockTo, up };
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    const result = defineMigration(def as any);
    expect(result).not.toHaveProperty('down');
  });

  it('preserves down when provided', () => {
    const down = async (item: unknown) => item;
    const def = { id: 'test', entityName: 'User', from: mockFrom, to: mockTo, up, down };
    // biome-ignore lint/suspicious/noExplicitAny: same as above
    const result = defineMigration(def as any);
    expect(result.down).toBe(down);
  });
});
