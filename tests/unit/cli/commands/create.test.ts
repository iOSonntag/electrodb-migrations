import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCreate } from '../../../../src/cli/commands/create.js';

/**
 * Plan 02-09 Task 2 — end-to-end behavioral tests for `runCreate`.
 *
 * Test surface (per <behavior>):
 * - SCF-01 happy path: greenfield → folder + bumped source + snapshot updated.
 * - SCF-07 no-drift refusal: process.exit(2) without --force.
 * - SCF-07 --force override: no drift but folder still scaffolded.
 * - Entity not found WITH suggestion (typo within Levenshtein <= 2).
 * - Entity not found WITHOUT suggestion (no close match).
 * - SCF-04 bump failure recovery: ts-morph refuses on a non-inline literal;
 *   migration folder DID land but snapshot is NOT updated; process.exit(1).
 * - CLI-09 remediation suffix: a known error path emits a `→ <remediation>` line.
 * - Task 1 contract smoke: re-asserts the exported-symbol shape for
 *   completeness (the orchestrator + command registrar must remain available).
 *
 * Fixture root note: jiti needs `electrodb` resolvable from the user-entity
 * file's location, so fixtures must live INSIDE the project tree (the OS
 * tmpdir is outside node_modules' resolution root). Same approach as
 * `tests/unit/cli/commands/baseline.test.ts`.
 */

const FIXTURE_ROOT = resolve(__dirname, '../../../../.tmp-tests/create');

let dir: string;

beforeAll(() => {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(FIXTURE_ROOT, 'edbm-create-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Scaffold a project with an `electrodb-migrations.config.ts` plus a single
 * `src/entities/user.ts` Entity. The user-source is the fixture text
 * (single-quoted version: '1', or refused-binding when forcing a bump
 * failure). Returns `{ entityFilePath }` so the test can read the bumped
 * source after the run.
 */
function setupProject(opts: { userSource: string; preExistingSnapshot?: object }): { entityFilePath: string } {
  mkdirSync(join(dir, 'src/entities'), { recursive: true });
  mkdirSync(join(dir, 'src/database/migrations'), { recursive: true });
  mkdirSync(join(dir, '.electrodb-migrations/snapshots'), { recursive: true });
  // Plain default-export shape (NOT `import { defineConfig }`) — same
  // reasoning as baseline.test.ts: the package's dist/ may not exist
  // during unit-test runs and `defineConfig` is identity anyway.
  writeFileSync(
    join(dir, 'electrodb-migrations.config.ts'),
    `export default {
       entities: 'src/entities',
       migrations: 'src/database/migrations',
       tableName: 'app_table',
     };`,
  );
  const entityFilePath = join(dir, 'src/entities/user.ts');
  writeFileSync(entityFilePath, opts.userSource);
  if (opts.preExistingSnapshot) {
    writeFileSync(join(dir, '.electrodb-migrations/snapshots/User.snapshot.json'), `${JSON.stringify(opts.preExistingSnapshot, null, 2)}\n`);
  }
  return { entityFilePath };
}

const USER_SINGLE_QUOTE = `import { Entity } from 'electrodb';
export const User = new Entity({
  model: { entity: 'User', service: 'app', version: '1' },
  attributes: {
    id: { type: 'string', required: true },
    email: { type: 'string', required: true },
  },
  indexes: {
    primary: {
      pk: { field: 'pk', composite: ['id'] },
      sk: { field: 'sk', composite: [] },
    },
  },
});
`;

const USER_REFUSED_BINDING = `import { Entity } from 'electrodb';
const VERSION = '1';
export const User = new Entity({
  model: { entity: 'User', service: 'app', version: VERSION },
  attributes: { id: { type: 'string', required: true } },
  indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
});
`;

/* ----- Task 1 contract smoke (carried forward) ------------------------- */

describe('src/cli/commands/create — Task 1 contract', () => {
  it('exports registerCreateCommand + runCreate', async () => {
    const mod = (await import('../../../../src/cli/commands/create.js')) as {
      registerCreateCommand?: unknown;
      runCreate?: unknown;
    };
    expect(typeof mod.registerCreateCommand).toBe('function');
    expect(typeof mod.runCreate).toBe('function');
  });
});

/* ----- Behavioral suite ------------------------------------------------ */

describe('runCreate — SCF-01 happy path (greenfield)', () => {
  it('scaffolds the migration folder, bumps the source, writes the snapshot', async () => {
    const { entityFilePath } = setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'add-status',
      force: false,
      // Pinned clock — Date.UTC(2026, 4, 1, 8, 30, 0) → 20260501083000
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Migration folder exists at <migrationsDir>/<timestamp>-<entity>-<slug>
    const folder = join(dir, 'src/database/migrations/20260501083000-User-add-status');
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(join(folder, 'v1.ts'))).toBe(true);
    expect(existsSync(join(folder, 'v2.ts'))).toBe(true);
    expect(existsSync(join(folder, 'migration.ts'))).toBe(true);

    // migration.ts boilerplate
    const migrationSrc = readFileSync(join(folder, 'migration.ts'), 'utf8');
    expect(migrationSrc).toContain("import { defineMigration } from 'electrodb-migrations';");
    expect(migrationSrc).toContain("id: '20260501083000-User-add-status'");
    expect(migrationSrc).toContain("entityName: 'User'");

    // User source bumped from version '1' to '2'
    const userSrcAfter = readFileSync(entityFilePath, 'utf8');
    expect(userSrcAfter).toContain("version: '2'");
    expect(userSrcAfter).not.toContain("version: '1'");

    // Snapshot written with the new fingerprint
    const snapshotPath = join(dir, '.electrodb-migrations/snapshots/User.snapshot.json');
    expect(existsSync(snapshotPath)).toBe(true);
    const snap = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      schemaVersion: number;
      fingerprint: string;
      frozenSnapshots: Array<{ migrationId: string; v1Sha256: string; v2Sha256: string }>;
    };
    expect(snap.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snap.frozenSnapshots).toHaveLength(1);
    expect(snap.frozenSnapshots[0]?.migrationId).toBe('20260501083000-User-add-status');
    expect(snap.frozenSnapshots[0]?.v1Sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snap.frozenSnapshots[0]?.v2Sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('logs the README §4 success summary lines on stderr', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'add-status',
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    const allStderr = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    // Drifts banner — 3 attribute-added drifts on greenfield (id + email + index — actually attribute-added per attribute + index-added; format covered by renderSchemaDiff tests).
    expect(allStderr).toMatch(/Found \d+ drift records? for entity 'User'/);
    // Migration folder line — relative path (not absolute).
    expect(allStderr).toContain('Generated migration folder: src/database/migrations/20260501083000-User-add-status');
    // Source bump line.
    expect(allStderr).toContain("Bumped User.model.version: '1' -> '2'");
    // Snapshot line.
    expect(allStderr).toContain('Updated snapshot for User');
    // Diff renderer header.
    expect(allStderr).toContain('User: v1 → v2');
  });
});

describe('runCreate — SCF-07 no-drift refusal', () => {
  it('exits with EXIT_CODES.DRIFT_NOT_DETECTED (2) when no shape drift and --force=false', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    // Run once to baseline the snapshot (greenfield → drifts → scaffolds).
    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'first',
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Bump the model.version BACK to '1' so the second run sees the same
    // projection as the snapshot. (`projection` excludes `model.version`
    // per DRF-03, so the fingerprint is unchanged and there is no drift —
    // exactly the "operator re-runs create with no schema changes" case.)
    // The user source is now version '2' from the first bump; reset it to
    // the original single-quote fixture (version '1') so the bump can
    // succeed if --force is passed in a follow-up test.
    writeFileSync(join(dir, 'src/entities/user.ts'), USER_SINGLE_QUOTE);

    // Second invocation: no drift → must call process.exit(2).
    await expect(
      runCreate({
        cwd: dir,
        entity: 'User',
        name: 'second',
        force: false,
        clock: () => Date.UTC(2026, 4, 2, 8, 30, 0),
      }),
    ).rejects.toThrow(/exit:2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('--force=true scaffolds anyway when no shape drift detected', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Baseline run.
    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'first',
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    // Restore source to '1' so the bump can target '1' -> '2' again.
    writeFileSync(join(dir, 'src/entities/user.ts'), USER_SINGLE_QUOTE);

    // Force a second migration even though the snapshot matches.
    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'behavior-only',
      force: true,
      clock: () => Date.UTC(2026, 4, 2, 8, 30, 0),
    });

    const folder = join(dir, 'src/database/migrations/20260502083000-User-behavior-only');
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(join(folder, 'v1.ts'))).toBe(true);
    expect(existsSync(join(folder, 'v2.ts'))).toBe(true);
    expect(existsSync(join(folder, 'migration.ts'))).toBe(true);
  });
});

describe('runCreate — entity not found', () => {
  it('throws with a "Did you mean ..." suggestion when a close match exists (Levenshtein <= 2)', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runCreate({
        cwd: dir,
        entity: 'Usre', // typo for 'User' — distance 2
        name: 'whatever',
        force: false,
      }),
    ).rejects.toThrow(/Entity 'Usre' not found.*Available entities: User.*Did you mean 'User'\?/s);
  });

  it('throws WITHOUT a "Did you mean" suggestion when no close match exists', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let thrown: unknown;
    try {
      await runCreate({
        cwd: dir,
        entity: 'Asteroid', // no entity even close to that name
        name: 'whatever',
        force: false,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Entity 'Asteroid' not found.");
    expect(message).toContain('Available entities: User.');
    expect(message).not.toContain('Did you mean');
  });

  it('attaches a `.remediation` field for the action wrapper to render via CLI-09', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    let thrown: unknown;
    try {
      await runCreate({
        cwd: dir,
        entity: 'Nope',
        name: 'whatever',
        force: false,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { remediation?: string }).remediation).toMatch(/Define the entity in your config\.entities directory or fix the --entity argument/);
  });
});

describe('runCreate — SCF-04 bump failure recovery', () => {
  it('on EDB_ENTITY_SOURCE_EDIT_ERROR: process.exit(1), folder DOES exist, snapshot NOT updated', async () => {
    setupProject({ userSource: USER_REFUSED_BINDING });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(
      runCreate({
        cwd: dir,
        entity: 'User',
        name: 'bump-fail',
        force: false,
        clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
      }),
    ).rejects.toThrow(/exit:1/);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Folder DID land (scaffold/create writes the folder before it bumps).
    const folder = join(dir, 'src/database/migrations/20260501083000-User-bump-fail');
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(join(folder, 'v1.ts'))).toBe(true);
    expect(existsSync(join(folder, 'v2.ts'))).toBe(true);
    expect(existsSync(join(folder, 'migration.ts'))).toBe(true);

    // Snapshot was NOT updated — operator can `rm -rf <folder>` and retry
    // (recovery path documented in scaffold/create.ts and surfaced in the
    // CLI-09 remediation message we assert below).
    const snapshotPath = join(dir, '.electrodb-migrations/snapshots/User.snapshot.json');
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it('CLI-09: writes a "→ Recover by ..." remediation line to stderr on bump failure', async () => {
    setupProject({ userSource: USER_REFUSED_BINDING });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(
      runCreate({
        cwd: dir,
        entity: 'User',
        name: 'bump-fail',
        force: false,
        clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
      }),
    ).rejects.toThrow(/exit:1/);

    const allStderr = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    // The error glyph + bump-failure message.
    expect(allStderr).toContain('bumpEntityVersion');
    // The CLI-09 dim-arrow remediation suffix line.
    expect(allStderr).toContain('→ The migration folder was scaffolded but the entity source was NOT bumped.');
    expect(allStderr).toContain('rm -rf <migration-folder>');
  });
});

describe('runCreate — operator-relative path output', () => {
  it('logs the migration folder path RELATIVE to cwd (not absolute)', async () => {
    setupProject({ userSource: USER_SINGLE_QUOTE });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCreate({
      cwd: dir,
      entity: 'User',
      name: 'rel-path',
      force: false,
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });

    const allStderr = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    const expected = relative(dir, join(dir, 'src/database/migrations/20260501083000-User-rel-path'));
    expect(allStderr).toContain(`Generated migration folder: ${expected}`);
    // Sanity: the absolute path of the folder should NOT appear (avoids leaking
    // a long $TMPDIR-prefixed path that's confusing for operators).
    const absolutePath = join(dir, 'src/database/migrations/20260501083000-User-rel-path');
    expect(allStderr).not.toContain(`Generated migration folder: ${absolutePath}`);
  });
});
