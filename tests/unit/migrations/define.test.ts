import { describe, expect, it } from 'vitest';
import { defineMigration } from '../../../src/migrations/define.js';
import type { AnyElectroEntity, Migration } from '../../../src/migrations/types.js';

describe('defineMigration (SCF-03 + Migration<F, T> surface)', () => {
  // Phase 2 ships only the runtime identity factory; Phase 8 tightens
  // up/down inference. Tests use a structurally-empty Entity stub since the
  // factory does not interact with the entity at runtime.
  const fakeEntity = {} as unknown as AnyElectroEntity;

  it('is an identity factory (returns input unchanged)', () => {
    const input: Migration<AnyElectroEntity, AnyElectroEntity> = {
      id: '20260501083000-User-add-status',
      entityName: 'User',
      from: fakeEntity,
      to: fakeEntity,
      up: async (record) => record,
    };
    expect(defineMigration(input)).toBe(input);
  });

  it('accepts the full Migration surface (all eight fields)', () => {
    const otherEntity = {} as unknown as AnyElectroEntity;
    const input: Migration<AnyElectroEntity, AnyElectroEntity> = {
      id: '20260501083000-User-add-status',
      entityName: 'User',
      from: fakeEntity,
      to: fakeEntity,
      up: async (record, _ctx) => ({ ...(record as object), status: 'active' }),
      down: async (record, _ctx) => {
        const { status: _drop, ...rest } = record as { status?: unknown };
        return rest;
      },
      reads: [otherEntity],
      rollbackResolver: () => 'projected',
    };
    const out = defineMigration(input);
    expect(out).toBe(input);
    expect(out.entityName).toBe('User');
    expect(out.reads).toHaveLength(1);
    expect(typeof out.down).toBe('function');
    expect(typeof out.rollbackResolver).toBe('function');
  });

  it('accepts the README Quick start minimum (mandatory fields only)', () => {
    const out = defineMigration({
      id: '20260501083000-User-add-status',
      entityName: 'User',
      from: fakeEntity,
      to: fakeEntity,
      up: async (record) => ({ ...(record as object), status: 'active' }),
    });
    expect(out.id).toBe('20260501083000-User-add-status');
    expect(out.down).toBeUndefined();
    expect(out.reads).toBeUndefined();
    expect(out.rollbackResolver).toBeUndefined();
  });
});
