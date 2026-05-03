import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EDBConfigLoadError,
  findConfigPath,
  loadConfigFile,
} from '../../../src/config/load.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findConfigPath (CFG-02)', () => {
  it('returns the absolute path when the .ts variant exists', () => {
    const target = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(target, 'export default {};');
    expect(findConfigPath(dir)).toBe(target);
  });

  it('prefers .ts over .json when both exist', () => {
    const ts = join(dir, 'electrodb-migrations.config.ts');
    const json = join(dir, 'electrodb-migrations.config.json');
    writeFileSync(ts, 'export default {};');
    writeFileSync(json, '{}');
    expect(findConfigPath(dir)).toBe(ts);
  });

  it('finds .json when no other extension exists', () => {
    const json = join(dir, 'electrodb-migrations.config.json');
    writeFileSync(json, '{"entities":"x","migrations":"m","tableName":"t"}');
    expect(findConfigPath(dir)).toBe(json);
  });

  it('returns null when no config file exists', () => {
    expect(findConfigPath(dir)).toBeNull();
  });
});

describe('loadConfigFile (CFG-03 — jiti TS loading)', () => {
  it('loads a typescript config and returns its default export', async () => {
    const path = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(
      path,
      `export default { entities: 'src/entities', migrations: 'm', tableName: 't' };`,
    );
    const cfg = (await loadConfigFile(path)) as { tableName: string };
    expect(cfg.tableName).toBe('t');
  });

  it('loads a JSON config', async () => {
    const path = join(dir, 'electrodb-migrations.config.json');
    writeFileSync(
      path,
      '{"entities":"src/entities","migrations":"m","tableName":"t"}',
    );
    const cfg = (await loadConfigFile(path)) as { tableName: string };
    expect(cfg.tableName).toBe('t');
  });

  it('wraps a thrown error from inside the config file as EDBConfigLoadError (Pitfall #9)', async () => {
    const path = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(path, `throw new Error('boom from config');`);
    let caught: unknown;
    try {
      await loadConfigFile(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBConfigLoadError);
    const err = caught as EDBConfigLoadError;
    expect(err.code).toBe('EDB_CONFIG_LOAD_ERROR');
    expect((err.details as { path: string }).path).toBe(path);
    expect((err.details as { cause: unknown }).cause).toBeDefined();
    expect(err.message).toContain('boom from config');
    expect(err.message).toContain(path);
  });

  it('returns the module namespace when no default export', async () => {
    const path = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(path, `export const tableName = 'named-only';`);
    const cfg = (await loadConfigFile(path)) as { tableName: string };
    expect(cfg.tableName).toBe('named-only');
  });
});
