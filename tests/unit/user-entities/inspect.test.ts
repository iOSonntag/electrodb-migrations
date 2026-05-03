import { describe, expect, it } from 'vitest';
import { extractEntityMetadata } from '../../../src/user-entities/inspect.js';

describe('extractEntityMetadata', () => {
  it('extracts a single entity from a module namespace (happy path)', () => {
    const mod = {
      User: { model: { entity: 'User', service: 'app', version: '1' } },
    };
    const out = extractEntityMetadata(mod, '/path/user.ts');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      entityName: 'User',
      modelEntity: 'User',
      modelService: 'app',
      modelVersion: '1',
      sourceFilePath: '/path/user.ts',
    });
    expect(out[0].entityInstance).toBe(mod.User);
  });

  it('returns multiple entities sorted alphabetically', () => {
    const mod = {
      User: { model: { entity: 'User', service: 'app', version: '1' } },
      Team: { model: { entity: 'Team', service: 'app', version: '1' } },
    };
    const out = extractEntityMetadata(mod, '/path/multi.ts');
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.entityName)).toEqual(['Team', 'User']);
  });

  it('skips non-entity exports (no model field)', () => {
    const mod = {
      User: { model: { entity: 'User', service: 'app', version: '1' } },
      someConstant: 42,
    };
    const out = extractEntityMetadata(mod, '/path/mixed.ts');
    expect(out).toHaveLength(1);
    expect(out[0].entityName).toBe('User');
  });

  it('skips exports with model present but missing entity/service/version', () => {
    const mod = {
      User: { model: { notAModel: true } },
    };
    const out = extractEntityMetadata(mod, '/path/bad.ts');
    expect(out).toHaveLength(0);
  });

  it('preserves numeric version (does not coerce)', () => {
    const mod = {
      User: { model: { entity: 'User', service: 'app', version: 1 } },
    };
    const out = extractEntityMetadata(mod, '/path/numeric.ts');
    expect(out).toHaveLength(1);
    expect(out[0].modelVersion).toBe(1);
    expect(typeof out[0].modelVersion).toBe('number');
  });

  it('does not throw on null model (defensive narrowing)', () => {
    const mod = {
      User: { model: null },
    };
    const out = extractEntityMetadata(mod, '/path/null-model.ts');
    expect(out).toHaveLength(0);
  });

  it('skips a default export that is not entity-shaped', () => {
    const mod = {
      default: { somethingElse: true },
      User: { model: { entity: 'User', service: 'app', version: '1' } },
    };
    const out = extractEntityMetadata(mod, '/path/default.ts');
    expect(out).toHaveLength(1);
    expect(out[0].entityName).toBe('User');
  });

  it('skips primitive exports without throwing', () => {
    const mod = {
      VERSION: '1.0.0',
      User: { model: { entity: 'User', service: 'app', version: '1' } },
    };
    const out = extractEntityMetadata(mod, '/path/mixed-primitives.ts');
    expect(out).toHaveLength(1);
    expect(out[0].entityName).toBe('User');
  });
});
