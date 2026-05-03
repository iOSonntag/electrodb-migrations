import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDBSnapshotMalformedError, readEntitySnapshot, readJournal } from '../../../src/snapshot/read.js';
import { EDBSnapshotVersionTooNewError } from '../../../src/snapshot/version.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-read-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readJournal', () => {
  it('reads a valid journal file', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        minSchemaVersion: 1,
        entries: [{ entity: 'User', snapshot: 'snapshots/User.snapshot.json' }],
      }),
    );
    const out = readJournal(path);
    expect(out.schemaVersion).toBe(1);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.entity).toBe('User');
  });

  it('throws EDBSnapshotVersionTooNewError when schemaVersion is in the future', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, minSchemaVersion: 99, entries: [] }));
    expect(() => readJournal(path)).toThrow(EDBSnapshotVersionTooNewError);
  });

  it('throws EDBSnapshotMalformedError when JSON is invalid', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, 'not-json{');
    expect(() => readJournal(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('error message for malformed JSON contains the file path', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, 'not-json{');
    try {
      readJournal(path);
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as Error).message).toContain(path);
    }
  });

  it('throws EDBSnapshotMalformedError when schemaVersion is missing', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, JSON.stringify({ entries: [] }));
    expect(() => readJournal(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('throws EDBSnapshotMalformedError when minSchemaVersion is missing', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [] }));
    expect(() => readJournal(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('throws EDBSnapshotMalformedError when entries is not an array', () => {
    const path = join(dir, '_journal.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, minSchemaVersion: 1, entries: 'oops' }));
    expect(() => readJournal(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('wraps unreadable file (ENOENT) as EDBSnapshotMalformedError', () => {
    const path = join(dir, 'nope.json');
    expect(() => readJournal(path)).toThrow(EDBSnapshotMalformedError);
  });
});

describe('readEntitySnapshot', () => {
  it('reads a valid entity snapshot', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        fingerprint: 'sha256:abc123',
        projection: { entity: 'User', service: 'app', attributes: {}, indexes: {} },
      }),
    );
    const out = readEntitySnapshot(path);
    expect(out.fingerprint).toBe('sha256:abc123');
    expect((out.projection as { entity: string }).entity).toBe('User');
  });

  it('throws EDBSnapshotVersionTooNewError when schemaVersion > FRAMEWORK_SNAPSHOT_VERSION', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, fingerprint: 'x', projection: {} }));
    expect(() => readEntitySnapshot(path)).toThrow(EDBSnapshotVersionTooNewError);
  });

  it('throws EDBSnapshotMalformedError when fingerprint is missing', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, projection: {} }));
    expect(() => readEntitySnapshot(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('throws EDBSnapshotMalformedError when projection is null', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, fingerprint: 'x', projection: null }));
    expect(() => readEntitySnapshot(path)).toThrow(EDBSnapshotMalformedError);
  });

  it('does not pollute Object.prototype when JSON contains __proto__', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(path, '{"schemaVersion":1,"fingerprint":"x","projection":{"__proto__":{"isAdmin":true}}}');
    const out = readEntitySnapshot(path);
    expect(out).toBeDefined();
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });

  it('does not pollute Object.prototype when top-level JSON contains __proto__', () => {
    const path = join(dir, 'User.snapshot.json');
    writeFileSync(path, '{"__proto__":{"isAdmin":true},"schemaVersion":1,"fingerprint":"x","projection":{}}');
    const out = readEntitySnapshot(path);
    expect(out).toBeDefined();
    expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  });
});
