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
