import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverEntityFiles } from '../../../src/user-entities/discover.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-discover-test-'));
  // tmp/src/entities/user.ts
  // tmp/src/entities/team.ts
  // tmp/src/entities/__tests__/user.test.ts  ← excluded
  // tmp/src/entities/types.d.ts               ← excluded
  // tmp/src/entities/sub/account.ts
  // tmp/node_modules/foo.ts                   ← excluded
  mkdirSync(join(dir, 'src/entities/__tests__'), { recursive: true });
  mkdirSync(join(dir, 'src/entities/sub'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'src/entities/user.ts'), '// user');
  writeFileSync(join(dir, 'src/entities/team.ts'), '// team');
  writeFileSync(join(dir, 'src/entities/__tests__/user.test.ts'), '// excluded');
  writeFileSync(join(dir, 'src/entities/types.d.ts'), '// excluded');
  writeFileSync(join(dir, 'src/entities/sub/account.ts'), '// account');
  writeFileSync(join(dir, 'src/entities/post.spec.ts'), '// excluded spec');
  writeFileSync(join(dir, 'node_modules/foo.ts'), '// excluded');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverEntityFiles', () => {
  it('walks a single directory and returns all .ts files (recursively)', async () => {
    const files = await discoverEntityFiles({ cwd: dir, entitiesConfig: 'src/entities' });
    // user.ts + team.ts + sub/account.ts = 3 files
    expect(files).toHaveLength(3);
    const basenames = files.map((f) => f.replace(dir, '')).sort();
    expect(basenames.some((b) => b.endsWith('user.ts'))).toBe(true);
    expect(basenames.some((b) => b.endsWith('team.ts'))).toBe(true);
    expect(basenames.some((b) => b.endsWith('account.ts'))).toBe(true);
  });

  it('accepts a single file path string', async () => {
    const files = await discoverEntityFiles({ cwd: dir, entitiesConfig: 'src/entities/user.ts' });
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(join(dir, 'src/entities/user.ts'));
  });

  it('accepts an array of file paths', async () => {
    const files = await discoverEntityFiles({
      cwd: dir,
      entitiesConfig: ['src/entities/user.ts', 'src/entities/team.ts'],
    });
    expect(files).toHaveLength(2);
    expect(files).toContain(join(dir, 'src/entities/user.ts'));
    expect(files).toContain(join(dir, 'src/entities/team.ts'));
  });

  it('excludes .test.ts, .spec.ts, and .d.ts files', async () => {
    const files = await discoverEntityFiles({ cwd: dir, entitiesConfig: 'src/entities' });
    for (const f of files) {
      expect(f.endsWith('.test.ts')).toBe(false);
      expect(f.endsWith('.spec.ts')).toBe(false);
      expect(f.endsWith('.d.ts')).toBe(false);
    }
  });

  it('does not traverse node_modules', async () => {
    const files = await discoverEntityFiles({
      cwd: dir,
      entitiesConfig: ['src/entities', 'node_modules'],
    });
    for (const f of files) {
      expect(f.includes('node_modules')).toBe(false);
    }
  });

  it('throws when a configured path does not exist', async () => {
    await expect(
      discoverEntityFiles({ cwd: dir, entitiesConfig: 'does-not-exist' }),
    ).rejects.toThrow();
  });

  it('returns a sorted (deterministic) array', async () => {
    const files = await discoverEntityFiles({ cwd: dir, entitiesConfig: 'src/entities' });
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it('returns absolute paths only', async () => {
    const files = await discoverEntityFiles({ cwd: dir, entitiesConfig: 'src/entities' });
    for (const f of files) {
      expect(isAbsolute(f)).toBe(true);
    }
  });

  it('deduplicates when the same file is reachable via two array entries', async () => {
    const files = await discoverEntityFiles({
      cwd: dir,
      entitiesConfig: ['src/entities/user.ts', 'src/entities/user.ts'],
    });
    expect(files).toHaveLength(1);
  });
});
