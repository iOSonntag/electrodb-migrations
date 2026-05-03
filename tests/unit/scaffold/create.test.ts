import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDBDriftNotDetectedError, scaffoldCreate } from '../../../src/scaffold/create.js';
import { computeIntegrityHash } from '../../../src/scaffold/integrity-hash.js';

/**
 * Plan 02-07 Task 2 — `scaffoldCreate` 12-step transactional flow.
 *
 * Test surface (per <behavior>):
 * - Happy path: drift detected → folder + bumped source + updated snapshot.
 * - No-drift refusal (force=false) → throws EDBDriftNotDetectedError.
 * - No-drift force=true → succeeds even with no drift.
 * - Greenfield (no prev snapshot) → creates new snapshot + journal.
 * - Bump failure recovery: folder written, snapshot NOT updated.
 * - Integrity hashes recorded on snapshot's frozenSnapshots.
 * - Migration ID determinism with fixed clock.
 * - Round-trip: bytes-on-disk hash equals stored v1Sha256.
 * - FND-06 invariant: scaffold/create.ts has no static ts-morph import.
 */

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/user-entity-styles');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-scaffold-create-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* ----- Test fixtures -------------------------------------------------- */

interface UserModelArgs {
  version?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Hand-constructed `entity.model` shape consumed by
 * `fingerprintEntityModel`. The shape mirrors what ElectroDB's parsed
 * model produces. Keeps tests independent of jiti's user-source loader.
 */
function userModel(args: UserModelArgs = {}): Record<string, unknown> {
  const version = args.version ?? '1';
  const attributes = args.attributes ?? {
    id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
    email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
  };
  return {
    entity: 'User',
    service: 'app',
    version,
    schema: { attributes },
    indexes: {
      primary: {
        type: 'isolated',
        pk: { field: 'pk', composite: ['id'] },
        sk: { field: 'sk', composite: [] },
      },
    },
  };
}

/** Models the user's previous projection (id + email); current is id + email + status. */
function userModelWithStatus(version = '1'): Record<string, unknown> {
  return userModel({
    version,
    attributes: {
      id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
      email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
      status: { type: 'string', required: false, hidden: false, readOnly: false, field: 'status' },
    },
  });
}

/** Copy a fixture entity-source into the tmp dir under entities/<name>.ts. */
function copyEntityFixture(fixtureName: string, targetName = 'user.ts'): string {
  const entitiesDir = join(dir, 'src', 'entities');
  mkdirSync(entitiesDir, { recursive: true });
  const dest = join(entitiesDir, targetName);
  copyFileSync(join(FIXTURE_ROOT, `${fixtureName}.ts`), dest);
  return dest;
}

/**
 * Write a Phase-1-shaped per-entity snapshot file containing the given
 * projection + fingerprint. Returns the absolute snapshot path.
 */
function writePrevSnapshot(entityName: string, projection: Record<string, unknown>, fingerprint: string): string {
  const snapDir = join(dir, '.electrodb-migrations', 'snapshots');
  mkdirSync(snapDir, { recursive: true });
  const path = join(snapDir, `${entityName}.snapshot.json`);
  const file = {
    schemaVersion: 2,
    fingerprint: `sha256:${fingerprint}`,
    projection,
    frozenSnapshots: [],
  };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return path;
}

/* ----- Tests ---------------------------------------------------------- */

describe('scaffoldCreate — happy path', () => {
  it('writes the migration folder with v1.ts, v2.ts, migration.ts and bumps the user source', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    // Previous projection: id + email (no status). Current: id + email + status.
    const prevProjection = {
      entity: 'User',
      service: 'app',
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
        email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };
    writePrevSnapshot('User', prevProjection, 'old-fingerprint-hex');

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'add-status',
      currentEntityModel: userModelWithStatus('1'),
      sourceFilePath: sourcePath,
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Migration ID matches deterministic format
    expect(result.migrationId).toBe('20260501083000-User-add-status');

    // Folder exists and contains the three expected files
    expect(existsSync(result.migrationFolderPath)).toBe(true);
    expect(existsSync(join(result.migrationFolderPath, 'v1.ts'))).toBe(true);
    expect(existsSync(join(result.migrationFolderPath, 'v2.ts'))).toBe(true);
    expect(existsSync(join(result.migrationFolderPath, 'migration.ts'))).toBe(true);

    // migration.ts contains expected boilerplate
    const migrationSrc = readFileSync(join(result.migrationFolderPath, 'migration.ts'), 'utf8');
    expect(migrationSrc).toContain("import { defineMigration } from 'electrodb-migrations';");
    expect(migrationSrc).toContain("  id: '20260501083000-User-add-status',");
    expect(migrationSrc).toContain("  entityName: 'User',");

    // User source now reads version: '2'
    const userSrcAfter = readFileSync(sourcePath, 'utf8');
    expect(userSrcAfter).toContain("version: '2'");
    expect(userSrcAfter).not.toContain("version: '1'");

    // Drifts include attribute-added for status
    expect(result.drifts.length).toBeGreaterThanOrEqual(1);
    expect(result.drifts.some((d) => d.kind === 'attribute-added')).toBe(true);

    // v1Sha256 / v2Sha256 are sha256:<hex>
    expect(result.v1Sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.v2Sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('updates the snapshot with new fingerprint + appended frozenSnapshots entry', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    const prevProjection = {
      entity: 'User',
      service: 'app',
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
        email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };
    const snapPath = writePrevSnapshot('User', prevProjection, 'old-fingerprint-hex');

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'add-status',
      currentEntityModel: userModelWithStatus('1'),
      sourceFilePath: sourcePath,
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Snapshot file now reflects the current projection + new frozenSnapshots entry.
    const after = JSON.parse(readFileSync(snapPath, 'utf8')) as {
      schemaVersion: number;
      fingerprint: string;
      projection: { attributes: Record<string, unknown> };
      frozenSnapshots: Array<{ migrationId: string; v1Sha256: string; v2Sha256: string }>;
    };
    expect(after.schemaVersion).toBe(2);
    expect(after.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(after.fingerprint).not.toBe('sha256:old-fingerprint-hex');
    expect(Object.keys(after.projection.attributes).sort()).toEqual(['email', 'id', 'status']);
    expect(after.frozenSnapshots).toHaveLength(1);
    expect(after.frozenSnapshots[0]?.migrationId).toBe(result.migrationId);
    expect(after.frozenSnapshots[0]?.v1Sha256).toBe(result.v1Sha256);
    expect(after.frozenSnapshots[0]?.v2Sha256).toBe(result.v2Sha256);
  });

  it('hashes recorded in frozenSnapshots match a fresh hash of the v1.ts/v2.ts bytes on disk', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    writePrevSnapshot(
      'User',
      {
        entity: 'User',
        service: 'app',
        attributes: {
          id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
          email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
        },
        indexes: {
          primary: {
            type: 'isolated',
            pk: { field: 'pk', composite: ['id'] },
            sk: { field: 'sk', composite: [] },
          },
        },
      },
      'old-fp',
    );

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'add-status',
      currentEntityModel: userModelWithStatus('1'),
      sourceFilePath: sourcePath,
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    const v1Bytes = readFileSync(join(result.migrationFolderPath, 'v1.ts'));
    const v2Bytes = readFileSync(join(result.migrationFolderPath, 'v2.ts'));
    expect(computeIntegrityHash(v1Bytes)).toBe(result.v1Sha256);
    expect(computeIntegrityHash(v2Bytes)).toBe(result.v2Sha256);
  });
});

describe('scaffoldCreate — no-drift refusal (SCF-07)', () => {
  it('throws EDBDriftNotDetectedError when force=false and prev fingerprint matches current', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    // Pre-existing snapshot with the SAME projection as the current model.
    const sameProjection = {
      entity: 'User',
      service: 'app',
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
        email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };
    writePrevSnapshot('User', sameProjection, 'fingerprint-here');

    let caught: unknown;
    try {
      await scaffoldCreate({
        cwd: dir,
        migrationsDir: 'src/database/migrations',
        entityName: 'User',
        slug: 'no-op',
        currentEntityModel: userModel(),
        sourceFilePath: sourcePath,
        force: false,
        clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EDBDriftNotDetectedError);
    expect((caught as EDBDriftNotDetectedError).code).toBe('EDB_DRIFT_NOT_DETECTED');
    expect((caught as Error).message).toContain('User');
    expect((caught as Error).message).toMatch(/--force|force/i);

    // No migration folder was created on the no-drift refusal path.
    const migDir = join(dir, 'src', 'database', 'migrations');
    expect(existsSync(migDir) ? readdirSync(migDir) : []).toEqual([]);

    // User source NOT bumped — version stays at '1'.
    const userSrcAfter = readFileSync(sourcePath, 'utf8');
    expect(userSrcAfter).toContain("version: '1'");
  });

  it('succeeds with force=true when no drift detected', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    const sameProjection = {
      entity: 'User',
      service: 'app',
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
        email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };
    writePrevSnapshot('User', sameProjection, 'fingerprint-here');

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'force-no-drift',
      currentEntityModel: userModel(),
      sourceFilePath: sourcePath,
      force: true,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    expect(result.drifts).toEqual([]);
    expect(existsSync(result.migrationFolderPath)).toBe(true);
    expect(existsSync(join(result.migrationFolderPath, 'migration.ts'))).toBe(true);

    const userSrcAfter = readFileSync(sourcePath, 'utf8');
    expect(userSrcAfter).toContain("version: '2'");
  });
});

describe('scaffoldCreate — greenfield (no prev snapshot)', () => {
  it('handles missing snapshot, writes new snapshot, creates _journal.json', async () => {
    const sourcePath = copyEntityFixture('single-quote');
    // No prev snapshot exists at all.

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'initial',
      currentEntityModel: userModel(),
      sourceFilePath: sourcePath,
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Migration folder exists.
    expect(existsSync(result.migrationFolderPath)).toBe(true);

    // Snapshot file written.
    const snapPath = join(dir, '.electrodb-migrations', 'snapshots', 'User.snapshot.json');
    expect(existsSync(snapPath)).toBe(true);
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as {
      frozenSnapshots: Array<{ migrationId: string }>;
    };
    expect(snap.frozenSnapshots).toHaveLength(1);
    expect(snap.frozenSnapshots[0]?.migrationId).toBe(result.migrationId);

    // _journal.json now lists the User entity.
    const journalPath = join(dir, '.electrodb-migrations', '_journal.json');
    expect(existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      schemaVersion: number;
      entries: Array<{ entity: string; snapshot: string }>;
    };
    expect(journal.entries.find((e) => e.entity === 'User')).toBeDefined();

    // User source bumped.
    const userSrcAfter = readFileSync(sourcePath, 'utf8');
    expect(userSrcAfter).toContain("version: '2'");
  });
});

describe('scaffoldCreate — bump failure recovery (Anti-Pattern 4 mitigation)', () => {
  it('throws EDBEntitySourceEditError; folder DOES exist; snapshot NOT updated', async () => {
    // refused-binding has `version: VERSION` (binding) — the bump will throw.
    const sourcePath = copyEntityFixture('refused-binding');

    const prevProjection = {
      entity: 'User',
      service: 'app',
      attributes: {
        id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };
    const snapPath = writePrevSnapshot('User', prevProjection, 'old-fingerprint-hex');
    const beforeSnap = readFileSync(snapPath, 'utf8');
    const beforeUserSrc = readFileSync(sourcePath, 'utf8');

    const userModelExtended = {
      entity: 'User',
      service: 'app',
      version: '1',
      schema: {
        attributes: {
          id: { type: 'string', required: true, hidden: false, readOnly: false, field: 'id' },
          email: { type: 'string', required: false, hidden: false, readOnly: false, field: 'email' },
        },
      },
      indexes: {
        primary: {
          type: 'isolated',
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    };

    let caught: unknown;
    try {
      await scaffoldCreate({
        cwd: dir,
        migrationsDir: 'src/database/migrations',
        entityName: 'User',
        slug: 'add-email',
        currentEntityModel: userModelExtended,
        sourceFilePath: sourcePath,
        force: false,
        clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('EDB_ENTITY_SOURCE_EDIT_ERROR');

    // Migration folder exists (write-folder happened before bump).
    const expectedFolder = join(dir, 'src', 'database', 'migrations', '20260501083000-User-add-email');
    expect(existsSync(expectedFolder)).toBe(true);
    expect(existsSync(join(expectedFolder, 'v1.ts'))).toBe(true);
    expect(existsSync(join(expectedFolder, 'v2.ts'))).toBe(true);
    expect(existsSync(join(expectedFolder, 'migration.ts'))).toBe(true);

    // Snapshot NOT updated (bytes identical).
    const afterSnap = readFileSync(snapPath, 'utf8');
    expect(afterSnap).toBe(beforeSnap);

    // User source NOT modified.
    const afterUserSrc = readFileSync(sourcePath, 'utf8');
    expect(afterUserSrc).toBe(beforeUserSrc);
  });
});

describe('scaffoldCreate — determinism', () => {
  it('migrationId matches `${formatted}-${entityName}-${slug}` with fixed clock', async () => {
    const sourcePath = copyEntityFixture('single-quote');

    const result = await scaffoldCreate({
      cwd: dir,
      migrationsDir: 'src/database/migrations',
      entityName: 'User',
      slug: 'Add Status!',
      currentEntityModel: userModel(),
      sourceFilePath: sourcePath,
      force: true,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    expect(result.migrationId).toBe('20260501083000-User-add-status');
  });
});

describe('scaffoldCreate — FND-06 invariant (no static ts-morph import)', () => {
  it("src/scaffold/create.ts contains no `from 'ts-morph'` static import", () => {
    const path = resolve(__dirname, '../../../src/scaffold/create.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/from\s+['"]ts-morph['"]/);
  });

  it('src/scaffold/create.ts dynamic-imports ./bump-entity-version.js (the ts-morph chain)', () => {
    const path = resolve(__dirname, '../../../src/scaffold/create.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/import\(\s*['"]\.\/bump-entity-version\.js['"]\s*\)/);
  });
});
