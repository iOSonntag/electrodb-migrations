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
  // Phase 2: migration factory (the Migration type export does NOT appear at runtime)
  'defineMigration',
];

const FORBIDDEN_RUNTIME_KEYS = [
  // Internal error classes per RESEARCH A7 (Phase 1)
  'EDBConfigInvariantViolationError',
  'EDBConfigLoadError',
  'EDBSnapshotMalformedError',
  'EDBSnapshotVersionTooNewError',
  'EDBBatchWriteExhaustedError',
  // Internal error classes — Phase 2 forward-protection. These do not exist
  // yet; the assertions guard against accidental leakage when later plans
  // create the symbols. Vitest's not.toContain() passes silently for absent
  // keys, so adding them now is safe.
  'EDBEntitySourceEditError', // Plan 04 internal error
  'EDBDriftNotDetectedError', // Plan 07 internal error
  'EDBUserEntityLoadError', // Plan 08 internal error — exported only from src/user-entities/index.ts
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
  // Internal helpers — Phase 2 forward-protection (Plans 02/03/04/05/06/07)
  'EXIT_CODES', // Plan 05 CLI-only constant
  'classifyDrift', // Plan 02 internal helper
  'renderFrozenEntitySource', // Plan 06 internal renderer
  'bumpEntityVersion', // Plan 04 internal helper (kept out due to ts-morph chain)
  'renderSchemaDiff', // Plan 02 internal renderer
  'createMigrationId', // Plan 03 internal helper
  // Internal helpers — drift
  // (drift/fingerprint.ts re-exports fingerprintEntityModel — that's a
  // framework-internal module and src/index.ts must not re-export it)
];

describe('public surface (src/index.ts)', () => {
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

  it('functional smoke: defineMigration is a runtime function (Phase 2)', () => {
    expect(typeof edbm.defineMigration).toBe('function');
  });

  it('functional smoke: EDBMigrationInProgressError carries the documented code', () => {
    const err = new edbm.EDBMigrationInProgressError('blocked', { runId: 'r1', lockState: 'apply' });
    expect(err.code).toBe('EDB_MIGRATION_IN_PROGRESS');
    expect(edbm.isMigrationInProgress(err)).toBe(true);
  });

  it('functional smoke: EDBRollbackNotPossibleError carries reason in details', () => {
    const err = new edbm.EDBRollbackNotPossibleError('cannot', { reason: 'NO_DOWN_FUNCTION' });
    expect((err.details as { reason: string }).reason).toBe('NO_DOWN_FUNCTION');
  });
});
