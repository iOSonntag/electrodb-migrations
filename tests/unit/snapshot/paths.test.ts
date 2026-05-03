import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JOURNAL_FILE_NAME,
  META_FILE_NAME,
  SNAPSHOTS_SUBDIR_NAME,
  SNAPSHOT_DIR_NAME,
  entitySnapshotPath,
  snapshotPaths,
} from '../../../src/snapshot/paths.js';

describe('snapshot path constants', () => {
  it('matches RESEARCH Pattern 6 conventions', () => {
    expect(SNAPSHOT_DIR_NAME).toBe('.electrodb-migrations');
    expect(JOURNAL_FILE_NAME).toBe('_journal.json');
    expect(META_FILE_NAME).toBe('_meta.json');
    expect(SNAPSHOTS_SUBDIR_NAME).toBe('snapshots');
  });
});

describe('snapshotPaths', () => {
  it('resolves the four canonical filesystem locations', () => {
    const out = snapshotPaths('/project');
    expect(out.root).toBe(resolve('/project', '.electrodb-migrations'));
    expect(out.journal).toBe(resolve('/project', '.electrodb-migrations/_journal.json'));
    expect(out.meta).toBe(resolve('/project', '.electrodb-migrations/_meta.json'));
    expect(out.snapshotsDir).toBe(resolve('/project', '.electrodb-migrations/snapshots'));
  });

  it('handles relative rootDir by resolving against cwd', () => {
    const out = snapshotPaths('.');
    expect(out.root).toBe(resolve(process.cwd(), '.electrodb-migrations'));
  });
});

describe('entitySnapshotPath', () => {
  it('builds <rootDir>/.electrodb-migrations/snapshots/<Entity>.snapshot.json', () => {
    expect(entitySnapshotPath('/project', 'User')).toBe(resolve('/project', '.electrodb-migrations/snapshots/User.snapshot.json'));
  });

  it('rejects entity names containing path separators', () => {
    expect(() => entitySnapshotPath('/project', 'foo/bar')).toThrow(/invalid entity name/);
    expect(() => entitySnapshotPath('/project', 'foo\\bar')).toThrow(/invalid entity name/);
  });

  it("rejects entity names containing '..'", () => {
    expect(() => entitySnapshotPath('/project', '..evil')).toThrow(/invalid entity name/);
  });

  it('rejects empty entity names', () => {
    expect(() => entitySnapshotPath('/project', '')).toThrow(/non-empty/);
  });
});
