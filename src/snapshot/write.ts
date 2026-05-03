import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical.js';
import type { EntitySnapshotFile, JournalFile } from './types.js';
import { FRAMEWORK_SNAPSHOT_VERSION } from './version.js';

/**
 * Stringify a value into deterministic, sorted-key, 2-space-indented JSON
 * ending with a newline. The strategy is to first run through
 * `canonicalJson` (which sorts keys recursively but produces a single line)
 * and then re-parse + pretty-print to add indentation while preserving the
 * sorted-key order. This guarantees byte-identical output for equivalent
 * inputs (SNP-01 + DRF-04).
 */
function stringifyForSnapshot(value: unknown): string {
  const canonical = canonicalJson(value);
  const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
  return `${pretty}\n`;
}

/**
 * Writes a JournalFile to `path`. Creates parent directories as needed.
 * Output is sorted-key, 2-space-indented JSON. SNP-01 + SNP-02.
 */
export function writeJournal(path: string, journal: JournalFile): void {
  // Stamp framework's current version on every write so a v0.2 framework
  // can detect a v0.1-written journal at read time.
  const payload: JournalFile = {
    schemaVersion: journal.schemaVersion ?? FRAMEWORK_SNAPSHOT_VERSION,
    minSchemaVersion: journal.minSchemaVersion ?? FRAMEWORK_SNAPSHOT_VERSION,
    entries: journal.entries,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyForSnapshot(payload), 'utf8');
}

/**
 * Writes a per-entity snapshot file. SNP-01 + SNP-02 + SNP-04.
 */
export function writeEntitySnapshot(path: string, snapshot: EntitySnapshotFile): void {
  const payload: EntitySnapshotFile = {
    schemaVersion: snapshot.schemaVersion ?? FRAMEWORK_SNAPSHOT_VERSION,
    fingerprint: snapshot.fingerprint,
    projection: snapshot.projection,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyForSnapshot(payload), 'utf8');
}
