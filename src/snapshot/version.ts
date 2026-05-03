import { EDBMigrationError } from '../errors/base.js';

/**
 * The schemaVersion the v0.1 CLI understands. Bump (and add a migration path)
 * whenever the snapshot file format changes incompatibly. Pitfall #16.
 */
export const FRAMEWORK_SNAPSHOT_VERSION = 1 as const;

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Thrown by the
 * snapshot reader when a `_journal.json` or per-entity snapshot file declares
 * a `schemaVersion` strictly greater than `FRAMEWORK_SNAPSHOT_VERSION`. The
 * intent is to surface a clear "upgrade your CLI" error rather than letting
 * the reader crash on an unknown projection shape.
 */
export class EDBSnapshotVersionTooNewError extends EDBMigrationError {
  readonly code = 'EDB_SNAPSHOT_VERSION_TOO_NEW' as const;
}

/**
 * Throws `EDBSnapshotVersionTooNewError` if `fileVersion > FRAMEWORK_SNAPSHOT_VERSION`.
 * Older `fileVersion` values are caller-territory: a backward-compatibility
 * read path may exist later (v0.2+) or the CLI may need to migrate the file.
 * For v0.1 we only gate the future-direction skew.
 */
export function assertSnapshotVersion(fileVersion: number, path: string): void {
  if (fileVersion > FRAMEWORK_SNAPSHOT_VERSION) {
    throw new EDBSnapshotVersionTooNewError(
      `Snapshot file ${path} has schemaVersion ${fileVersion}, but this CLI ` +
        `understands at most ${FRAMEWORK_SNAPSHOT_VERSION}. Upgrade the CLI.`,
      { path, fileVersion, frameworkVersion: FRAMEWORK_SNAPSHOT_VERSION },
    );
  }
}
