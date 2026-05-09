/**
 * Unit tests for `buildCtx` — covers CTX-01, CTX-04, CTX-05.
 *
 * RED phase: written before the implementation and expected to FAIL at import
 * time because `src/ctx/build-ctx.ts` does not exist yet.
 *
 * CTX-01: ctx returned by buildCtx has an `entity()` method.
 * CTX-04: ctx.entity(SelfEntity) throws EDBSelfReadInMigrationError.
 *   - Declared in reads array: throw at buildCtx construction time.
 *   - Called at runtime (undeclared self-read): throw at ctx.entity() call time.
 * CTX-05: fingerprint validation before any DDB call.
 *   - Declared, mismatch: buildCtx rejects with EDBStaleEntityReadError.
 *   - Declared, match: buildCtx resolves.
 *   - Undeclared, lazy mismatch: ctx.entity() throws EDBStaleEntityReadError.
 *   - Undeclared, lazy cache: second ctx.entity() call does NOT re-read snapshot.
 *
 * Wave 1 (Plan 06-03) removes the @ts-expect-error comment on the import and
 * implements buildCtx. The tests then flip from RED (import-fails) to GREEN.
 *
 * RESEARCH §Pattern 1, §OQ3, §OQ4.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCtx } from '../../../src/ctx/build-ctx.js';
import { EDBSelfReadInMigrationError, EDBStaleEntityReadError } from '../../../src/errors/index.js';
import { Entity } from 'electrodb';
import { fingerprintEntityModel } from '../../../src/safety/fingerprint-projection.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStubDocClient, writeTestSnapshot } from './_helpers.js';

// ---------------------------------------------------------------------------
// Local helpers for this test file
// ---------------------------------------------------------------------------

/**
 * Build a real ElectroDB Entity (not a stub) bound to the stub client.
 * Required because buildCtx calls fingerprintEntityModel(entity.model).
 */
function makeRealEntity(entityName: string, client: ReturnType<typeof makeStubDocClient>) {
  return new Entity(
    {
      model: { entity: entityName, version: '1', service: 'app' },
      attributes: { id: { type: 'string', required: true } },
      indexes: { byId: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
    },
    { client, table: 'test-table' },
  );
}

/** Build a minimal migration stub for buildCtx. */
// biome-ignore lint/suspicious/noExplicitAny: Migration generic boundary for tests.
function makeMigration(opts: { entityName: string; reads?: any[] }): any {
  return {
    id: '20260601000099-test',
    entityName: opts.entityName,
    from: {},
    to: {},
    up: async (r: unknown) => r,
    ...(opts.reads !== undefined ? { reads: opts.reads } : {}),
  };
}

/** Return a unique temp dir for this test's snapshot files. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ctx-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCtx', () => {
  // ----- CTX-04: self-read detection -----

  describe('CTX-04: self-read detection', () => {
    it('throws EDBSelfReadInMigrationError when reads contains the migration entity name', async () => {
      const client = makeStubDocClient();
      const userEntity = makeRealEntity('User', client);
      const migration = makeMigration({ entityName: 'User', reads: [userEntity] });
      const dir = makeTempDir();

      await expect(buildCtx(migration, client, 'test-table', dir)).rejects.toThrow(EDBSelfReadInMigrationError);
    });

    it('throws EDBSelfReadInMigrationError when ctx.entity(Self) is called at runtime (undeclared self-read)', async () => {
      const client = makeStubDocClient();
      const userEntity = makeRealEntity('User', client);
      const teamEntity = makeRealEntity('Team', client);
      const dir = makeTempDir();

      // Write a valid Team snapshot so buildCtx can read it
      const { fingerprint } = fingerprintEntityModel((teamEntity as unknown as { model: unknown }).model);
      writeTestSnapshot(dir, 'Team', fingerprint);

      const migration = makeMigration({ entityName: 'User', reads: [teamEntity] });

      const ctx = await buildCtx(migration, client, 'test-table', dir);
      // Now try to call ctx.entity with the User (self) — must throw
      expect(() => ctx.entity(userEntity)).toThrow(EDBSelfReadInMigrationError);
    });
  });

  // ----- CTX-05: fingerprint pre-flight (declared, eager) -----

  describe('CTX-05: fingerprint pre-flight (declared, eager)', () => {
    it('throws EDBStaleEntityReadError when on-disk snapshot fingerprint mismatches imported entity', async () => {
      const client = makeStubDocClient();
      const teamEntity = makeRealEntity('Team', client);
      const dir = makeTempDir();

      // Write a WRONG fingerprint snapshot
      writeTestSnapshot(dir, 'Team', 'wrong-fingerprint-value');

      const migration = makeMigration({ entityName: 'User', reads: [teamEntity] });

      await expect(buildCtx(migration, client, 'test-table', dir)).rejects.toThrow(EDBStaleEntityReadError);
    });

    it('resolves when fingerprint matches the imported entity', async () => {
      const client = makeStubDocClient();
      const teamEntity = makeRealEntity('Team', client);
      const dir = makeTempDir();

      // Write the CORRECT fingerprint
      const { fingerprint } = fingerprintEntityModel((teamEntity as unknown as { model: unknown }).model);
      writeTestSnapshot(dir, 'Team', fingerprint);

      const migration = makeMigration({ entityName: 'User', reads: [teamEntity] });

      await expect(buildCtx(migration, client, 'test-table', dir)).resolves.toBeDefined();
    });
  });

  // ----- CTX-05: lazy validation (undeclared reads targets) -----

  describe('CTX-05: lazy validation (undeclared)', () => {
    it('throws EDBStaleEntityReadError at ctx.entity() call when snapshot fingerprint mismatches', async () => {
      const client = makeStubDocClient();
      const teamEntity = makeRealEntity('Team', client);
      const dir = makeTempDir();

      // Write a WRONG fingerprint snapshot for Team
      writeTestSnapshot(dir, 'Team', 'wrong-fingerprint-for-lazy');

      // Migration has no reads — Team is undeclared
      const migration = makeMigration({ entityName: 'User' });

      const ctx = await buildCtx(migration, client, 'test-table', dir);
      expect(() => ctx.entity(teamEntity)).toThrow(EDBStaleEntityReadError);
    });

    it('caches the validated facade — second ctx.entity() call does NOT re-read the snapshot', async () => {
      const { unlinkSync } = await import('node:fs');
      const client = makeStubDocClient();
      const teamEntity = makeRealEntity('Team', client);
      const dir = makeTempDir();

      // Write the CORRECT fingerprint
      const { fingerprint } = fingerprintEntityModel((teamEntity as unknown as { model: unknown }).model);
      const snapshotPath = writeTestSnapshot(dir, 'Team', fingerprint);

      const migration = makeMigration({ entityName: 'User' });
      const ctx = await buildCtx(migration, client, 'test-table', dir);

      // First call primes the cache (reads and validates the snapshot file).
      ctx.entity(teamEntity);

      // Delete the snapshot file so any subsequent real disk read would fail.
      unlinkSync(snapshotPath);

      // Second call must NOT throw — the facade was cached after the first call
      // and must be returned directly without re-reading the (now-deleted) snapshot.
      expect(() => ctx.entity(teamEntity)).not.toThrow();
    });
  });

  // ----- CTX-01: ctx.entity() surface -----

  describe('CTX-01: MigrationCtx surface', () => {
    it('ctx returned by buildCtx has an entity() method', async () => {
      const client = makeStubDocClient();
      const dir = makeTempDir();

      const migration = makeMigration({ entityName: 'User' });

      const ctx = await buildCtx(migration, client, 'test-table', dir);
      expect(typeof ctx.entity).toBe('function');
    });
  });
});
