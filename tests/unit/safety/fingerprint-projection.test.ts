import { describe, expect, it } from 'vitest';
import { fingerprintEntityModel, projectEntityModel } from '../../../src/safety/fingerprint-projection.js';

/** Builds a minimal `entity.model`-shaped object suitable for fingerprinting tests. */
function makeModel(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    entity: 'User',
    service: 'app',
    version: '1',
    schema: {
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
        email: {
          type: 'string',
          required: true,
          hidden: false,
          readOnly: false,
          field: 'email',
        },
      },
    },
    indexes: {
      byId: {
        type: 'isolated',
        pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
        sk: { field: 'sk', composite: [], template: '' },
      },
    },
    ...overrides,
  };
}

describe('projectEntityModel — DRF-02 allowlist', () => {
  it('includes only allowlisted attribute fields', () => {
    const model = makeModel();
    const proj = projectEntityModel(model);
    expect(proj.entity).toBe('User');
    expect(proj.service).toBe('app');
    expect(proj.attributes.id).toEqual({
      type: 'string',
      required: true,
      hidden: false,
      readOnly: false,
      field: 'id',
    });
  });

  it('includes enumArray, properties, items, template, padding when present', () => {
    const model = makeModel({
      schema: {
        attributes: {
          status: {
            type: 'enum',
            enumArray: ['active', 'inactive'],
            required: true,
            hidden: false,
            readOnly: false,
            field: 'status',
          },
          meta: {
            type: 'map',
            required: false,
            hidden: false,
            readOnly: false,
            field: 'meta',
            properties: {
              key: { type: 'string', required: false, hidden: false, readOnly: false, field: 'key' },
            },
          },
          tags: {
            type: 'list',
            required: false,
            hidden: false,
            readOnly: false,
            field: 'tags',
            items: { type: 'string', required: false, hidden: false, readOnly: false, field: 'item' },
          },
          paddedId: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'paddedId',
            template: 'PAD#${id}',
            padding: { length: 5, char: '0' },
          },
        },
      },
    });
    const proj = projectEntityModel(model);
    expect(proj.attributes.status?.enumArray).toEqual(['active', 'inactive']);
    expect(proj.attributes.meta?.properties?.key?.type).toBe('string');
    expect((proj.attributes.tags?.items as { type: string }).type).toBe('string');
    expect(proj.attributes.paddedId?.template).toBe('PAD#${id}');
    expect(proj.attributes.paddedId?.padding).toEqual({ length: 5, char: '0' });
  });

  it('excludes closures: validate, get, set, default, cast', () => {
    const baseAttr = { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' };
    const a = makeModel({
      schema: {
        attributes: { id: { ...baseAttr } },
      },
    });
    const b = makeModel({
      schema: {
        attributes: {
          id: {
            ...baseAttr,
            validate: () => true,
            get: (v: unknown) => v,
            set: (v: unknown) => v,
            default: () => 'x',
            cast: 'string',
          },
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('excludes label, watching, watchedBy, watchAll (per Q2 — behavior-only)', () => {
    const a = makeModel();
    const b = makeModel({
      schema: {
        attributes: {
          id: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'id',
            label: '#',
            watching: ['email'],
          },
          email: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'email',
          },
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });
});

describe('projectEntityModel — DRF-03 model-level exclusions', () => {
  it('excludes model.version', () => {
    const a = makeModel({ version: '1' });
    const b = makeModel({ version: '99' });
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('excludes model.translations / lookup / original', () => {
    const a = makeModel();
    const b = makeModel({
      translations: { foo: 'bar' },
      lookup: { x: 1 },
      original: { raw: 'whatever' },
    });
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('excludes sparse-index condition closures', () => {
    const a = makeModel();
    const b = makeModel({
      indexes: {
        byId: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: [], template: '' },
          condition: () => true,
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });
});

describe('fingerprintEntityModel — DRF-01 + DRF-04 (determinism)', () => {
  it('is stable across 100 invocations on the same input', () => {
    const model = makeModel();
    const baseline = fingerprintEntityModel(model).fingerprint;
    for (let i = 0; i < 100; i += 1) {
      expect(fingerprintEntityModel(model).fingerprint).toBe(baseline);
    }
  });

  it('produces the same fingerprint for two equivalent inputs with reordered keys', () => {
    const a = makeModel();
    const b = {
      service: 'app',
      version: '1',
      entity: 'User',
      indexes: {
        byId: {
          sk: { template: '', composite: [], field: 'sk' },
          pk: { template: 'USER#${id}', composite: ['id'], casing: 'default', field: 'pk' },
          type: 'isolated',
        },
      },
      schema: {
        attributes: {
          email: {
            field: 'email',
            type: 'string',
            readOnly: false,
            hidden: false,
            required: true,
          },
          id: {
            field: 'id',
            readOnly: false,
            hidden: false,
            required: true,
            type: 'string',
          },
        },
      },
    };
    expect(fingerprintEntityModel(a).fingerprint).toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('detects attribute rename (different attribute key)', () => {
    const a = makeModel();
    const b = makeModel({
      schema: {
        attributes: {
          userId: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
          email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).not.toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('detects field rename (attribute.field changed)', () => {
    const a = makeModel();
    const b = makeModel({
      schema: {
        attributes: {
          id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
          email: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'emailAddr',
          },
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).not.toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('detects template change on pk (Q1 disposition: stored-bytes-affecting)', () => {
    const a = makeModel();
    const b = makeModel({
      indexes: {
        byId: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'CUSTOMER#${id}' },
          sk: { field: 'sk', composite: [], template: '' },
        },
      },
    });
    expect(fingerprintEntityModel(a).fingerprint).not.toBe(fingerprintEntityModel(b).fingerprint);
  });

  it('Phase 1 success criterion 3: behavior-only diff → same hash; rename → different hash', () => {
    const baseline = makeModel();

    // Behavior-only diff: validators/getters/sparse-index condition all change
    const behaviorOnly = makeModel({
      schema: {
        attributes: {
          id: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'id',
            validate: () => true,
            get: (v: unknown) => v,
          },
          email: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'email',
          },
        },
      },
      indexes: {
        byId: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'], casing: 'default', template: 'USER#${id}' },
          sk: { field: 'sk', composite: [], template: '' },
          condition: () => true,
        },
      },
    });
    expect(fingerprintEntityModel(baseline).fingerprint).toBe(fingerprintEntityModel(behaviorOnly).fingerprint);

    // Rename: attribute key changes
    const renamed = makeModel({
      schema: {
        attributes: {
          userId: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'id',
          },
          email: {
            type: 'string',
            required: true,
            hidden: false,
            readOnly: false,
            field: 'email',
          },
        },
      },
    });
    expect(fingerprintEntityModel(baseline).fingerprint).not.toBe(fingerprintEntityModel(renamed).fingerprint);
  });
});

describe('fingerprint format', () => {
  it('returns a 64-character lowercase hex SHA-256 digest', () => {
    const { fingerprint } = fingerprintEntityModel(makeModel());
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
