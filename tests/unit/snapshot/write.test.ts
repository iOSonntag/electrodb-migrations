import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEntitySnapshot, readJournal } from '../../../src/snapshot/read.js';
import { writeEntitySnapshot, writeJournal } from '../../../src/snapshot/write.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-write-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeJournal', () => {
  it('writes sorted-key, 2-space-indented JSON ending in newline', () => {
    const path = join(dir, '_journal.json');
    writeJournal(path, {
      schemaVersion: 1,
      minSchemaVersion: 1,
      entries: [{ entity: 'User', snapshot: 'snapshots/User.snapshot.json' }],
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  ');
    expect(raw).toContain('"schemaVersion"');
    // Sorted-key order at the top level: entries, minSchemaVersion, schemaVersion (alphabetical).
    const order = raw.match(/^ {2}"(\w+)":/gm);
    expect(order).toBeDefined();
    const keys = (order ?? []).map((s) => s.replace(/^ {2}"|":$/g, ''));
    expect(keys).toEqual(['entries', 'minSchemaVersion', 'schemaVersion']);
  });

  it('creates parent directories that do not exist', () => {
    const path = join(dir, 'nested/deep/_journal.json');
    writeJournal(path, { schemaVersion: 1, minSchemaVersion: 1, entries: [] });
    expect(readFileSync(path, 'utf8')).toContain('schemaVersion');
  });

  it('round-trips with readJournal', () => {
    const path = join(dir, '_journal.json');
    const journal = {
      schemaVersion: 1,
      minSchemaVersion: 1,
      entries: [
        { entity: 'User', snapshot: 'snapshots/User.snapshot.json' },
        { entity: 'Team', snapshot: 'snapshots/Team.snapshot.json' },
      ],
    };
    writeJournal(path, journal);
    expect(readJournal(path)).toEqual(journal);
  });
});

describe('writeEntitySnapshot', () => {
  it('round-trips with readEntitySnapshot', () => {
    const path = join(dir, 'User.snapshot.json');
    const snap = {
      schemaVersion: 1,
      fingerprint: 'sha256:abc',
      projection: {
        entity: 'User',
        service: 'app',
        attributes: { id: { type: 'string', required: true } },
        indexes: { byId: { type: 'isolated', pk: { field: 'pk', composite: ['id'] } } },
      },
    };
    writeEntitySnapshot(path, snap);
    expect(readEntitySnapshot(path)).toEqual(snap);
  });

  it('produces byte-identical output for two equivalent inputs with reordered keys', () => {
    const pathA = join(dir, 'A.json');
    const pathB = join(dir, 'B.json');
    writeEntitySnapshot(pathA, {
      schemaVersion: 1,
      fingerprint: 'x',
      projection: { z: 1, a: 2 },
    });
    writeEntitySnapshot(pathB, {
      schemaVersion: 1,
      fingerprint: 'x',
      projection: { a: 2, z: 1 },
    });
    expect(readFileSync(pathA, 'utf8')).toBe(readFileSync(pathB, 'utf8'));
  });

  it('keys appear in sorted order at every nesting level', () => {
    const path = join(dir, 'sorted.json');
    writeEntitySnapshot(path, {
      schemaVersion: 1,
      fingerprint: 'x',
      projection: { z: { y: 1, x: 2 }, a: { c: 3, b: 4 } },
    });
    const raw = readFileSync(path, 'utf8');
    const aIdx = raw.indexOf('"a"');
    const zIdx = raw.indexOf('"z"');
    const bIdx = raw.indexOf('"b"');
    const cIdx = raw.indexOf('"c"');
    const xIdx = raw.indexOf('"x"');
    const yIdx = raw.indexOf('"y"');
    expect(aIdx).toBeLessThan(zIdx);
    expect(bIdx).toBeLessThan(cIdx);
    expect(xIdx).toBeLessThan(yIdx);
  });

  it('output ends with a single newline', () => {
    const path = join(dir, 'newline.json');
    writeEntitySnapshot(path, { schemaVersion: 1, fingerprint: 'x', projection: {} });
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });
});
