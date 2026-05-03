import { describe, expect, it } from 'vitest';
import { EDBSnapshotVersionTooNewError, FRAMEWORK_SNAPSHOT_VERSION, assertSnapshotVersion } from '../../../src/snapshot/version.js';

describe('FRAMEWORK_SNAPSHOT_VERSION', () => {
  it('is the literal 2', () => {
    expect(FRAMEWORK_SNAPSHOT_VERSION).toBe(2);
  });
});

describe('assertSnapshotVersion', () => {
  it('returns silently when fileVersion equals the framework version', () => {
    expect(() => assertSnapshotVersion(2, '/x.json')).not.toThrow();
  });

  it('still accepts fileVersion 1 silently (backward compat with v0.1 snapshots)', () => {
    expect(() => assertSnapshotVersion(1, '/x.json')).not.toThrow();
  });

  it('returns silently when fileVersion is older than the framework version', () => {
    expect(() => assertSnapshotVersion(0, '/x.json')).not.toThrow();
  });

  it('rejects fileVersion 3 with EDBSnapshotVersionTooNewError', () => {
    expect(() => assertSnapshotVersion(3, '/x.json')).toThrow(EDBSnapshotVersionTooNewError);
  });

  it('rejects newer schemaVersion with EDBSnapshotVersionTooNewError', () => {
    let caught: unknown;
    try {
      assertSnapshotVersion(99, '/path/to/User.snapshot.json');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBSnapshotVersionTooNewError);
    expect((caught as EDBSnapshotVersionTooNewError).code).toBe('EDB_SNAPSHOT_VERSION_TOO_NEW');
  });

  it('error message contains path, fileVersion, and frameworkVersion', () => {
    try {
      assertSnapshotVersion(99, '/path/to/User.snapshot.json');
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as Error).message).toContain('/path/to/User.snapshot.json');
      expect((e as Error).message).toContain('99');
      expect((e as Error).message).toContain('2');
    }
  });

  it('error.details carries {path, fileVersion, frameworkVersion} and is frozen', () => {
    try {
      assertSnapshotVersion(3, '/foo.json');
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as EDBSnapshotVersionTooNewError;
      expect(err.details).toEqual({
        path: '/foo.json',
        fileVersion: 3,
        frameworkVersion: 2,
      });
      expect(Object.isFrozen(err.details)).toBe(true);
    }
  });
});
