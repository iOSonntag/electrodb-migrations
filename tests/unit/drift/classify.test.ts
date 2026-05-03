import { describe, expect, it } from 'vitest';
import {
  type Drift,
  classifyDrift,
} from '../../../src/drift/classify.js';
import type {
  EntityProjection,
  ProjectedAttribute,
  ProjectedIndex,
} from '../../../src/safety/fingerprint-projection.js';

/**
 * Builds a minimal `EntityProjection` shape for classifier tests.
 * Mirrors the `makeModel` builder in
 * tests/unit/safety/fingerprint-projection.test.ts but produces a
 * post-projection shape (closed allowlist; no behavior fields).
 */
function makeAttribute(overrides: Partial<ProjectedAttribute> = {}): ProjectedAttribute {
  return {
    type: 'string',
    required: true,
    hidden: false,
    readOnly: false,
    field: '',
    ...overrides,
  };
}

function makeIndex(overrides: Partial<ProjectedIndex> = {}): ProjectedIndex {
  return {
    type: 'isolated',
    pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
    sk: { field: 'sk', composite: [], template: '' },
    ...overrides,
  };
}

function makeProjection(overrides: Partial<EntityProjection> = {}): EntityProjection {
  return {
    entity: 'User',
    service: 'app',
    attributes: {
      id: makeAttribute({ field: 'id' }),
      email: makeAttribute({ field: 'email' }),
    },
    indexes: {
      primary: makeIndex(),
    },
    ...overrides,
  };
}

describe('classifyDrift — null/empty cases (DRF-06 behavior-only no-op)', () => {
  it('returns [] for two byte-equal projections', () => {
    const p = makeProjection();
    expect(classifyDrift(p, p)).toEqual([]);
  });

  it('returns [] for two structurally equal projections (different references)', () => {
    expect(classifyDrift(makeProjection(), makeProjection())).toEqual([]);
  });

  it('returns [] for null prev + null curr', () => {
    expect(classifyDrift(null, null)).toEqual([]);
  });

  it('DRF-06: two projections that differ ONLY in fields stripped by Phase 1 allowlist produce zero drift', () => {
    // Both projections are post-allowlist — closures, validators, sparse-condition
    // were stripped upstream by `projectEntityModel`. Two identical projections
    // therefore represent "behavior-only changed" upstream input.
    const a = makeProjection();
    const b = makeProjection();
    expect(classifyDrift(a, b)).toEqual([]);
  });
});

describe('classifyDrift — entity-removed', () => {
  it('emits entity-removed when curr is null and prev is non-null', () => {
    const p = makeProjection({ entity: 'User', service: 'app' });
    expect(classifyDrift(p, null)).toEqual([
      { kind: 'entity-removed', entity: 'User', service: 'app' },
    ]);
  });
});

describe('classifyDrift — greenfield baseline (null prev → projection curr)', () => {
  it('emits attribute-added per attribute (alphabetical) + index-added per index', () => {
    const p = makeProjection({
      attributes: {
        zeta: makeAttribute({ field: 'zeta' }),
        alpha: makeAttribute({ field: 'alpha', required: false }),
      },
      indexes: {
        secondary: makeIndex({ pk: { field: 'gsi1pk', composite: ['email'] } }),
        primary: makeIndex(),
      },
    });
    const result = classifyDrift(null, p);
    // alphabetical within each kind; attribute-added before index-added
    expect(result).toEqual([
      { kind: 'attribute-added', name: 'alpha', type: 'string', required: false, warnNeedsDefault: false },
      { kind: 'attribute-added', name: 'zeta', type: 'string', required: true, warnNeedsDefault: true },
      { kind: 'index-added', name: 'primary', pkComposite: ['id'], skComposite: [] },
      { kind: 'index-added', name: 'secondary', pkComposite: ['email'] },
    ]);
  });
});

describe('classifyDrift — attribute-added', () => {
  it('required attribute → warnNeedsDefault=true', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      attributes: {
        ...makeProjection().attributes,
        status: makeAttribute({ type: 'string', required: true, field: 'status' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      { kind: 'attribute-added', name: 'status', type: 'string', required: true, warnNeedsDefault: true },
    ]);
  });

  it('non-required attribute → warnNeedsDefault=false', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      attributes: {
        ...makeProjection().attributes,
        nickname: makeAttribute({ type: 'string', required: false, field: 'nickname' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      { kind: 'attribute-added', name: 'nickname', type: 'string', required: false, warnNeedsDefault: false },
    ]);
  });

  it('multiple added attributes are alphabetical', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      attributes: {
        ...makeProjection().attributes,
        zeta: makeAttribute({ field: 'zeta', required: false }),
        alpha: makeAttribute({ field: 'alpha', required: false }),
      },
    });
    const result = classifyDrift(prev, curr);
    expect(result.map((d) => (d as { name: string }).name)).toEqual(['alpha', 'zeta']);
  });
});

describe('classifyDrift — attribute-removed', () => {
  it('emits attribute-removed for missing attribute', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        deprecated: makeAttribute({ type: 'number', field: 'deprecated' }),
      },
    });
    const curr = makeProjection();
    expect(classifyDrift(prev, curr)).toEqual([
      { kind: 'attribute-removed', name: 'deprecated', type: 'number' },
    ]);
  });
});

describe('classifyDrift — attribute-changed', () => {
  it('detects type change (single field)', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ type: 'string', field: 'id' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ type: 'number', field: 'id' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'attribute-changed',
        name: 'id',
        changes: [{ field: 'type', from: 'string', to: 'number' }],
      },
    ]);
  });

  it('detects multiple field changes ordered alphabetically by field', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ type: 'string', required: false, field: 'id' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ type: 'number', required: true, field: 'id' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    const result = classifyDrift(prev, curr) as ReadonlyArray<{
      kind: string;
      name: string;
      changes: Array<{ field: string; from: unknown; to: unknown }>;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('attribute-changed');
    expect(result[0]?.changes.map((c) => c.field)).toEqual(['required', 'type']);
  });

  it('A2 RESEARCH: enumArray reorder IS shape-affecting', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        status: makeAttribute({
          type: 'enum',
          enumArray: ['active', 'inactive'],
          field: 'status',
        }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        status: makeAttribute({
          type: 'enum',
          enumArray: ['inactive', 'active'],
          field: 'status',
        }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'attribute-changed',
        name: 'status',
        changes: [
          { field: 'enumArray', from: ['active', 'inactive'], to: ['inactive', 'active'] },
        ],
      },
    ]);
  });

  it('detects field-name change (storage column rename)', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'emailAddr' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'attribute-changed',
        name: 'email',
        changes: [{ field: 'field', from: 'email', to: 'emailAddr' }],
      },
    ]);
  });

  it('detects template change on attribute', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id', template: 'OLD#${id}' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id', template: 'NEW#${id}' }),
        email: makeAttribute({ field: 'email' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'attribute-changed',
        name: 'id',
        changes: [{ field: 'template', from: 'OLD#${id}', to: 'NEW#${id}' }],
      },
    ]);
  });

  it('detects nested properties change (map type)', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        meta: makeAttribute({
          type: 'map',
          field: 'meta',
          properties: { key: makeAttribute({ field: 'key' }) },
        }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        meta: makeAttribute({
          type: 'map',
          field: 'meta',
          properties: { key: makeAttribute({ field: 'renamedKey' }) },
        }),
      },
    });
    const result = classifyDrift(prev, curr) as ReadonlyArray<{
      kind: string;
      name: string;
      changes: Array<{ field: string }>;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('attribute-changed');
    expect(result[0]?.changes.map((c) => c.field)).toEqual(['properties']);
  });

  it('detects items change (list type)', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        tags: makeAttribute({ type: 'list', field: 'tags', items: 'string' }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        tags: makeAttribute({ type: 'list', field: 'tags', items: 'number' }),
      },
    });
    const result = classifyDrift(prev, curr) as ReadonlyArray<{
      kind: string;
      changes: Array<{ field: string }>;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.changes.map((c) => c.field)).toEqual(['items']);
  });
});

describe('classifyDrift — index-added', () => {
  it('emits index-added with composite arrays', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      indexes: {
        primary: makeIndex(),
        secondary: makeIndex({
          pk: { field: 'gsi1pk', composite: ['email'] },
          sk: { field: 'gsi1sk', composite: ['createdAt'] },
        }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'index-added',
        name: 'secondary',
        pkComposite: ['email'],
        skComposite: ['createdAt'],
      },
    ]);
  });

  it('omits skComposite when sk is absent on the new index', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      indexes: {
        primary: makeIndex(),
        bare: { type: 'isolated', pk: { field: 'gsi2pk', composite: ['x'] } },
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      { kind: 'index-added', name: 'bare', pkComposite: ['x'] },
    ]);
  });
});

describe('classifyDrift — index-removed', () => {
  it('emits index-removed for missing index', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex(),
        deprecated: makeIndex({ pk: { field: 'gsi1pk', composite: ['x'] } }),
      },
    });
    const curr = makeProjection();
    expect(classifyDrift(prev, curr)).toEqual([
      { kind: 'index-removed', name: 'deprecated' },
    ]);
  });
});

describe('classifyDrift — index-changed', () => {
  it('detects type flip (isolated → clustered)', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({ type: 'clustered' }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [{ field: 'type', from: 'isolated', to: 'clustered' }],
      },
    ]);
  });

  it('detects multiple changes (composite + casing)', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: ['createdAt'], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id', 'tenant'], casing: 'lower', template: 'USER#${id}' },
          sk: { field: 'sk', composite: ['createdAt'], template: '' },
        }),
      },
    });
    const result = classifyDrift(prev, curr) as ReadonlyArray<{
      kind: string;
      name: string;
      changes: Array<{ field: string }>;
    }>;
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('index-changed');
    expect(result[0]?.changes.map((c) => c.field)).toEqual(['pk.casing', 'pk.composite']);
  });

  it('detects collection change', () => {
    const prev = makeProjection({
      indexes: { primary: makeIndex({ collection: 'usersGroup' }) },
    });
    const curr = makeProjection({
      indexes: { primary: makeIndex({ collection: 'accountsGroup' }) },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [{ field: 'collection', from: 'usersGroup', to: 'accountsGroup' }],
      },
    ]);
  });
});

describe('classifyDrift — key-rename heuristic', () => {
  it('classifies pk single-position rename as key-rename (not index-changed)', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['userId'], casing: 'default', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['accountId'], casing: 'default', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'key-rename',
        index: 'primary',
        keyType: 'pk',
        from: 'userId',
        to: 'accountId',
      },
    ]);
  });

  it('classifies sk single-position rename as key-rename', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: ['createdAt'], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: ['updatedAt'], template: '' },
        }),
      },
    });
    expect(classifyDrift(prev, curr)).toEqual([
      {
        kind: 'key-rename',
        index: 'primary',
        keyType: 'sk',
        from: 'createdAt',
        to: 'updatedAt',
      },
    ]);
  });

  it('NOT a key-rename: composite length differs → index-changed', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['id', 'tenant'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const result = classifyDrift(prev, curr);
    expect(result).toEqual([
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [{ field: 'pk.composite', from: ['id'], to: ['id', 'tenant'] }],
      },
    ]);
  });

  it('NOT a key-rename: more than one position differs → index-changed', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['userId', 'tenantId'], casing: 'default', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['accountId', 'orgId'], casing: 'default', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const result = classifyDrift(prev, curr);
    expect(result).toEqual([
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [
          {
            field: 'pk.composite',
            from: ['userId', 'tenantId'],
            to: ['accountId', 'orgId'],
          },
        ],
      },
    ]);
  });

  it('NOT a key-rename: composite changed AND another field also changed → index-changed', () => {
    const prev = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['userId'], casing: 'default', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const curr = makeProjection({
      indexes: {
        primary: makeIndex({
          pk: { field: 'pk', composite: ['accountId'], casing: 'lower', template: 'USER#${userId}' },
          sk: { field: 'sk', composite: [], template: '' },
        }),
      },
    });
    const result = classifyDrift(prev, curr) as Drift[];
    expect(result[0]?.kind).toBe('index-changed');
  });
});

describe('classifyDrift — output ordering (deterministic)', () => {
  it('kinds emitted in locked sequence; alphabetical within each kind', () => {
    const prev = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        zRemoved: makeAttribute({ field: 'zRemoved' }),
        aRemoved: makeAttribute({ field: 'aRemoved' }),
        cChanged: makeAttribute({ type: 'string', field: 'cChanged' }),
      },
      indexes: {
        primary: makeIndex(),
        zRemoved: makeIndex({ pk: { field: 'gsi1pk', composite: ['x'] } }),
        aRemoved: makeIndex({ pk: { field: 'gsi2pk', composite: ['y'] } }),
        cChanged: makeIndex({ type: 'isolated', pk: { field: 'gsi3pk', composite: ['z'] } }),
      },
    });
    const curr = makeProjection({
      attributes: {
        id: makeAttribute({ field: 'id' }),
        email: makeAttribute({ field: 'email' }),
        zAdded: makeAttribute({ field: 'zAdded', required: false }),
        aAdded: makeAttribute({ field: 'aAdded', required: false }),
        cChanged: makeAttribute({ type: 'number', field: 'cChanged' }),
      },
      indexes: {
        primary: makeIndex(),
        zAdded: makeIndex({ pk: { field: 'gsi4pk', composite: ['p'] } }),
        aAdded: makeIndex({ pk: { field: 'gsi5pk', composite: ['q'] } }),
        cChanged: makeIndex({ type: 'clustered', pk: { field: 'gsi3pk', composite: ['z'] } }),
      },
    });
    const result = classifyDrift(prev, curr);
    const kinds = result.map((d) => d.kind);
    expect(kinds).toEqual([
      'attribute-added', // aAdded
      'attribute-added', // zAdded
      'attribute-removed', // aRemoved
      'attribute-removed', // zRemoved
      'attribute-changed', // cChanged
      'index-added', // aAdded
      'index-added', // zAdded
      'index-removed', // aRemoved
      'index-removed', // zRemoved
      'index-changed', // cChanged
    ]);
    // Alphabetical within each kind
    const names = result.map((d) => {
      if ('name' in d) return d.name;
      if ('index' in d) return d.index;
      if ('entity' in d) return d.entity;
      return '';
    });
    expect(names).toEqual([
      'aAdded',
      'zAdded',
      'aRemoved',
      'zRemoved',
      'cChanged',
      'aAdded',
      'zAdded',
      'aRemoved',
      'zRemoved',
      'cChanged',
    ]);
  });

  it('determinism: two invocations on same input produce deeply-equal output', () => {
    const prev = makeProjection();
    const curr = makeProjection({
      attributes: {
        ...makeProjection().attributes,
        status: makeAttribute({ field: 'status' }),
      },
    });
    const r1 = classifyDrift(prev, curr);
    const r2 = classifyDrift(prev, curr);
    expect(r1).toEqual(r2);
  });
});
