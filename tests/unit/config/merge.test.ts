import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD, DEFAULT_LOCK, DEFAULT_RUNNER } from '../../../src/config/defaults.js';
import { resolveConfig } from '../../../src/config/merge.js';
import type { MigrationsConfig } from '../../../src/config/types.js';

const baseFile: MigrationsConfig = {
  entities: 'src/entities',
  migrations: 'src/database/migrations',
  tableName: 'app_table',
};

describe('resolveConfig (CFG-11 precedence chain)', () => {
  it('applies all defaults when only required fields are specified', () => {
    const out = resolveConfig(baseFile);
    expect(out.lock).toEqual(DEFAULT_LOCK);
    expect(out.guard).toEqual(DEFAULT_GUARD);
    expect(out.runner).toEqual(DEFAULT_RUNNER);
    expect(out.entities).toEqual(['src/entities']);
    expect(out.tableName).toBe('app_table');
  });

  it('file config overrides defaults', () => {
    const out = resolveConfig({
      ...baseFile,
      lock: { heartbeatMs: 5_000 },
    });
    expect(out.lock.heartbeatMs).toBe(5_000);
    expect(out.lock.staleThresholdMs).toBe(DEFAULT_LOCK.staleThresholdMs);
    expect(out.lock.acquireWaitMs).toBe(DEFAULT_LOCK.acquireWaitMs);
  });

  it('overrides take precedence over file config', () => {
    const out = resolveConfig({ ...baseFile, lock: { heartbeatMs: 5_000 } }, { lock: { heartbeatMs: 1_000 } });
    expect(out.lock.heartbeatMs).toBe(1_000);
  });

  it('multiple sections honor precedence independently', () => {
    const out = resolveConfig({ ...baseFile, guard: { cacheTtlMs: 1_000 } }, { lock: { heartbeatMs: 999 } });
    expect(out.guard.cacheTtlMs).toBe(1_000);
    expect(out.guard.blockMode).toBe('all');
    expect(out.lock.heartbeatMs).toBe(999);
    expect(out.lock.acquireWaitMs).toBe(DEFAULT_LOCK.acquireWaitMs);
  });

  it('normalizes string `entities` to array', () => {
    const out = resolveConfig({ ...baseFile, entities: 'one' });
    expect(out.entities).toEqual(['one']);
  });

  it('preserves array `entities` as array', () => {
    const out = resolveConfig({ ...baseFile, entities: ['a', 'b'] });
    expect(out.entities).toEqual(['a', 'b']);
  });

  it('overrides.entities replaces file.entities entirely', () => {
    const out = resolveConfig({ ...baseFile, entities: ['file1', 'file2'] }, { entities: 'override-only' });
    expect(out.entities).toEqual(['override-only']);
  });

  it('migrationStartVersions: overrides win on key collision', () => {
    const out = resolveConfig(
      {
        ...baseFile,
        migrationStartVersions: { User: { version: 5 }, Team: { version: 1 } },
      },
      { migrationStartVersions: { User: { version: 7 } } },
    );
    expect(out.migrationStartVersions).toEqual({
      User: { version: 7 },
      Team: { version: 1 },
    });
  });
});

describe('resolveConfig — built-in path defaults (CFG-12)', () => {
  it('fills entities + migrations from built-in defaults when both layers omit them', () => {
    const out = resolveConfig({}, {});
    expect(out.entities).toEqual(['src/database/entities']);
    expect(out.migrations).toBe('src/database/migrations');
  });

  it('file-supplied entities still override the built-in default', () => {
    const out = resolveConfig({ entities: 'custom/entities' });
    expect(out.entities).toEqual(['custom/entities']);
  });

  it('override-supplied migrations wins over file and default', () => {
    const out = resolveConfig({ migrations: 'file/path' }, { migrations: 'override/path' });
    expect(out.migrations).toBe('override/path');
  });

  it('tableName widens to undefined when no layer supplies it (invariants narrows later)', () => {
    const out = resolveConfig({});
    expect(out.tableName).toBeUndefined();
  });
});

describe('resolveConfig — remote section spread (entries #3 / #5)', () => {
  it('returns remote: undefined when both layers omit it', () => {
    const out = resolveConfig({});
    expect(out.remote).toBeUndefined();
  });

  it('per-section spread: override.url + file.apiKey compose into one remote', () => {
    const out = resolveConfig(
      { remote: { url: 'u-from-file', apiKey: 'k-from-file' } },
      { remote: { url: 'u-from-override' } },
    );
    expect(out.remote).toEqual({ url: 'u-from-override', apiKey: 'k-from-file' });
  });

  it('per-section spread: file.url + override.apiKey compose into one remote', () => {
    const out = resolveConfig({ remote: { url: 'u1' } }, { remote: { apiKey: 'k1' } });
    expect(out.remote).toEqual({ url: 'u1', apiKey: 'k1' });
  });

  it('override fields win on collision; file fields are retained for the rest', () => {
    const out = resolveConfig(
      { remote: { url: 'u-file', apiKey: 'k-file' } },
      { remote: { url: 'u-override' } },
    );
    expect(out.remote).toEqual({ url: 'u-override', apiKey: 'k-file' });
  });
});
