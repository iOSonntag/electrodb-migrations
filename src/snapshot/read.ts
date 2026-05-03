import { readFileSync } from 'node:fs';
import { EDBMigrationError } from '../errors/base.js';
import type { EntitySnapshotFile, JournalFile } from './types.js';
import { assertSnapshotVersion } from './version.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Thrown when a
 * snapshot file is unreadable, not valid JSON, or missing required fields.
 */
export class EDBSnapshotMalformedError extends EDBMigrationError {
  readonly code = 'EDB_SNAPSHOT_MALFORMED' as const;
}

function parseJsonOrThrow(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new EDBSnapshotMalformedError(`Cannot read snapshot file: ${path}`, { path, cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new EDBSnapshotMalformedError(`Snapshot file is not valid JSON: ${path}`, { path, cause: err });
  }
}

/** Reads `_journal.json`, asserts schemaVersion, returns typed shape. */
export function readJournal(path: string): JournalFile {
  const data = parseJsonOrThrow(path) as Record<string, unknown>;
  if (typeof data.schemaVersion !== 'number') {
    throw new EDBSnapshotMalformedError(`Snapshot file missing schemaVersion (number): ${path}`, { path });
  }
  assertSnapshotVersion(data.schemaVersion, path);
  if (typeof data.minSchemaVersion !== 'number') {
    throw new EDBSnapshotMalformedError(`Journal missing minSchemaVersion (number): ${path}`, { path });
  }
  if (!Array.isArray(data.entries)) {
    throw new EDBSnapshotMalformedError(`Journal missing entries (array): ${path}`, { path });
  }
  return {
    schemaVersion: data.schemaVersion,
    minSchemaVersion: data.minSchemaVersion,
    entries: data.entries as JournalFile['entries'],
  };
}

/** Reads `<EntityName>.snapshot.json`, asserts schemaVersion, returns typed shape. */
export function readEntitySnapshot(path: string): EntitySnapshotFile {
  const data = parseJsonOrThrow(path) as Record<string, unknown>;
  if (typeof data.schemaVersion !== 'number') {
    throw new EDBSnapshotMalformedError(`Snapshot file missing schemaVersion (number): ${path}`, { path });
  }
  assertSnapshotVersion(data.schemaVersion, path);
  if (typeof data.fingerprint !== 'string') {
    throw new EDBSnapshotMalformedError(`Snapshot file missing fingerprint (string): ${path}`, { path });
  }
  if (typeof data.projection !== 'object' || data.projection === null) {
    throw new EDBSnapshotMalformedError(`Snapshot file missing projection (object): ${path}`, { path });
  }
  // SNP-03 (Phase 2): propagate the optional frozenSnapshots field. v1
  // (schemaVersion: 1) snapshots may omit it entirely — in that case the
  // result also omits the field (matches the type's optional shape). When
  // present, it must be an array.
  const result: EntitySnapshotFile = {
    schemaVersion: data.schemaVersion,
    fingerprint: data.fingerprint,
    projection: data.projection as Record<string, unknown>,
  };
  if (data.frozenSnapshots !== undefined) {
    if (!Array.isArray(data.frozenSnapshots)) {
      throw new EDBSnapshotMalformedError(`Snapshot file frozenSnapshots must be an array: ${path}`, { path });
    }
    result.frozenSnapshots = data.frozenSnapshots as NonNullable<EntitySnapshotFile['frozenSnapshots']>;
  }
  return result;
}
