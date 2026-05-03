import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EDBUserEntityLoadError, loadEntityFile } from '../../../src/user-entities/load.js';

// Tests that exercise jiti loading of files importing 'electrodb' must place
// fixtures inside the project tree so Node's bare-specifier resolution can
// walk up to the project's `node_modules/electrodb`. Writing fixtures into
// `os.tmpdir()` causes ERR_MODULE_NOT_FOUND for the `electrodb` import — the
// OS tmp dir is outside any package.json/node_modules ancestry.
const FIXTURE_ROOT = resolve(__dirname, '../../../.tmp-tests/load');

let dir: string;

beforeAll(() => {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(FIXTURE_ROOT, 'edbm-load-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadEntityFile', () => {
  it('loads a TS file and returns its module namespace with named exports', async () => {
    const path = join(dir, 'user.ts');
    writeFileSync(
      path,
      `import { Entity } from 'electrodb';
       export const User = new Entity({
         model: { entity: 'User', service: 'app', version: '1' },
         attributes: { id: { type: 'string', required: true } },
         indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
       });`,
    );
    const mod = await loadEntityFile(path);
    expect(mod).toBeDefined();
    expect('User' in mod).toBe(true);
  });

  it('loads a file with two entity exports', async () => {
    const path = join(dir, 'multi.ts');
    writeFileSync(
      path,
      `import { Entity } from 'electrodb';
       export const User = new Entity({
         model: { entity: 'User', service: 'app', version: '1' },
         attributes: { id: { type: 'string', required: true } },
         indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
       });
       export const Team = new Entity({
         model: { entity: 'Team', service: 'app', version: '1' },
         attributes: { id: { type: 'string', required: true } },
         indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
       });`,
    );
    const mod = await loadEntityFile(path);
    expect('User' in mod).toBe(true);
    expect('Team' in mod).toBe(true);
  });

  it('wraps a syntax error in EDBUserEntityLoadError', async () => {
    const path = join(dir, 'broken.ts');
    writeFileSync(path, 'this is not valid typescript {{{ ');
    let caught: unknown;
    try {
      await loadEntityFile(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBUserEntityLoadError);
    const err = caught as EDBUserEntityLoadError;
    expect(err.code).toBe('EDB_USER_ENTITY_LOAD_ERROR');
    expect((err.details as { sourceFilePath: string }).sourceFilePath).toBe(path);
    expect((err.details as { cause: unknown }).cause).toBeDefined();
    expect(err.message).toContain(path);
  });

  it('wraps a runtime throw in EDBUserEntityLoadError', async () => {
    const path = join(dir, 'throws.ts');
    writeFileSync(path, `throw new Error('boom from entity');`);
    let caught: unknown;
    try {
      await loadEntityFile(path);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBUserEntityLoadError);
    const err = caught as EDBUserEntityLoadError;
    expect(err.code).toBe('EDB_USER_ENTITY_LOAD_ERROR');
    expect(err.message).toContain('boom from entity');
  });
});
