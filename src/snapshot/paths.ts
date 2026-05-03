import { join, resolve } from 'node:path';

/**
 * The framework-managed state directory at the user's project root.
 * Documented in RESEARCH Pattern 6.
 */
export const SNAPSHOT_DIR_NAME = '.electrodb-migrations' as const;
export const JOURNAL_FILE_NAME = '_journal.json' as const;
export const META_FILE_NAME = '_meta.json' as const;
export const SNAPSHOTS_SUBDIR_NAME = 'snapshots' as const;

export interface SnapshotPaths {
  /** Absolute path of `<rootDir>/.electrodb-migrations`. */
  root: string;
  /** Absolute path of `<rootDir>/.electrodb-migrations/_journal.json`. */
  journal: string;
  /** Absolute path of `<rootDir>/.electrodb-migrations/_meta.json`. */
  meta: string;
  /** Absolute path of `<rootDir>/.electrodb-migrations/snapshots`. */
  snapshotsDir: string;
}

/**
 * Resolves the canonical filesystem layout. SNP-01.
 *
 * @param rootDir - The user's project root (typically `process.cwd()`).
 */
export function snapshotPaths(rootDir: string): SnapshotPaths {
  const root = resolve(rootDir, SNAPSHOT_DIR_NAME);
  return {
    root,
    journal: join(root, JOURNAL_FILE_NAME),
    meta: join(root, META_FILE_NAME),
    snapshotsDir: join(root, SNAPSHOTS_SUBDIR_NAME),
  };
}

/**
 * Resolves the absolute path of a per-entity snapshot file. Validates
 * `entityName` does not contain path separators or `..` segments — the
 * snapshots directory is framework-managed and must not allow user input
 * to escape it.
 */
export function entitySnapshotPath(rootDir: string, entityName: string): string {
  if (entityName.length === 0) {
    throw new Error('entitySnapshotPath: entity name must be non-empty');
  }
  if (entityName.includes('/') || entityName.includes('\\') || entityName.includes('..')) {
    throw new Error(`entitySnapshotPath: invalid entity name "${entityName}" — must not contain path separators or '..'`);
  }
  const { snapshotsDir } = snapshotPaths(rootDir);
  return join(snapshotsDir, `${entityName}.snapshot.json`);
}
