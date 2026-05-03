import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as edbm from '../../../src/index.js';

const EXPECTED_RUNTIME_KEYS = [
  // Eight error classes
  'EDBMigrationError',
  'EDBMigrationInProgressError',
  'EDBMigrationLockHeldError',
  'EDBRequiresRollbackError',
  'EDBRollbackNotPossibleError',
  'EDBRollbackOutOfOrderError',
  'EDBSelfReadInMigrationError',
  'EDBStaleEntityReadError',
  // The duck-typed checker
  'isMigrationInProgress',
  // Config factory (the two type exports do NOT appear at runtime)
  'defineConfig',
];

const FORBIDDEN_RUNTIME_KEYS = [
  // Internal error classes per RESEARCH A7
  'EDBConfigInvariantViolationError',
  'EDBConfigLoadError',
  'EDBSnapshotMalformedError',
  'EDBSnapshotVersionTooNewError',
  'EDBBatchWriteExhaustedError',
  // Internal helpers — config
  'resolveConfig',
  'loadConfigFile',
  'findConfigPath',
  'validateConfigInvariants',
  // Internal helpers — snapshot
  'readJournal',
  'readEntitySnapshot',
  'writeJournal',
  'writeEntitySnapshot',
  'canonicalJson',
  'assertSnapshotVersion',
  'snapshotPaths',
  'entitySnapshotPath',
  'FRAMEWORK_SNAPSHOT_VERSION',
  // Internal helpers — safety
  'CONSISTENT_READ',
  'CONSISTENT_READ_MARKER',
  'startHeartbeatScheduler',
  'withBatchWriteRetry',
  'fingerprintEntityModel',
  'projectEntityModel',
  // Internal helpers — drift
  // (drift/fingerprint.ts re-exports fingerprintEntityModel — that's a
  // framework-internal module and src/index.ts must not re-export it)
];

describe('Phase 1 public surface (src/index.ts)', () => {
  it('exposes exactly the documented runtime symbols', () => {
    const actual = Object.keys(edbm).sort();
    expect(actual).toEqual([...EXPECTED_RUNTIME_KEYS].sort());
  });

  it('does NOT expose internal error classes (RESEARCH A7)', () => {
    const actual = new Set(Object.keys(edbm));
    for (const k of FORBIDDEN_RUNTIME_KEYS) {
      expect(actual.has(k), `Internal symbol leaked into public surface: ${k}`).toBe(false);
    }
  });

  it('FND-06: src/index.ts does not import ts-morph', () => {
    const path = resolve(__dirname, '../../../src/index.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/from\s+['"]ts-morph['"]/);
    expect(src).not.toMatch(/import\(\s*['"]ts-morph['"]\s*\)/);
  });

  it('functional smoke: defineConfig is identity', () => {
    const cfg = edbm.defineConfig({
      entities: 'src/entities',
      migrations: 'src/database/migrations',
      tableName: 'app_table',
    });
    expect(cfg.tableName).toBe('app_table');
  });

  it('functional smoke: EDBMigrationInProgressError carries the documented code', () => {
    const err = new edbm.EDBMigrationInProgressError('blocked', { runId: 'r1', lockState: 'apply' });
    expect(err.code).toBe('EDB_MIGRATION_IN_PROGRESS');
    expect(edbm.isMigrationInProgress(err)).toBe(true);
  });

  it('functional smoke: EDBRollbackNotPossibleError carries reason in details', () => {
    const err = new edbm.EDBRollbackNotPossibleError('cannot', { reason: 'no-down-fn' });
    expect((err.details as { reason: string }).reason).toBe('no-down-fn');
  });
});
