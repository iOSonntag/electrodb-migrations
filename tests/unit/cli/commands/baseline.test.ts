import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBaseline } from '../../../../src/cli/commands/baseline.js';

// Fixtures must live inside the project tree so jiti can resolve `electrodb`
// from the user-entity files. OS-level tmpdir paths fail bare-specifier
// resolution. Same approach as tests/unit/user-entities/load.test.ts.
const FIXTURE_ROOT = resolve(__dirname, '../../../../.tmp-tests/baseline');

let dir: string;

beforeAll(() => {
  mkdirSync(FIXTURE_ROOT, { recursive: true });
});

afterAll(() => {
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(FIXTURE_ROOT, 'edbm-baseline-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Helper: scaffold a project with an electrodb-migrations.config.ts pointing
 * at `src/entities/` and two real ElectroDB Entity files (User + Team). The
 * config is intentionally minimal so resolveCliConfig succeeds without
 * tripping the §5.3 invariant.
 */
function setupProject(root: string): void {
  mkdirSync(join(root, 'src/entities'), { recursive: true });
  // The Entity test fixtures use a single-PK index (no SK) — the simplest
  // shape the fingerprint projection accepts.
  writeFileSync(
    join(root, 'src/entities/user.ts'),
    `import { Entity } from 'electrodb';
     export const User = new Entity({
       model: { entity: 'User', service: 'app', version: '1' },
       attributes: {
         id: { type: 'string', required: true },
         name: { type: 'string', required: true },
       },
       indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
     });`,
  );
  writeFileSync(
    join(root, 'src/entities/team.ts'),
    `import { Entity } from 'electrodb';
     export const Team = new Entity({
       model: { entity: 'Team', service: 'app', version: '1' },
       attributes: {
         id: { type: 'string', required: true },
         name: { type: 'string', required: true },
       },
       indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
     });`,
  );
  writeFileSync(
    join(root, 'electrodb-migrations.config.ts'),
    `import { defineConfig } from 'electrodb-migrations';
     export default defineConfig({
       entities: 'src/entities',
       migrations: 'src/database/migrations',
       tableName: 'app_table',
     });`,
  );
}

describe('runBaseline (INI-03)', () => {
  it('first run snapshots all discovered entities (greenfield)', async () => {
    setupProject(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runBaseline({ cwd: dir });

    const userSnap = join(dir, '.electrodb-migrations/snapshots/User.snapshot.json');
    const teamSnap = join(dir, '.electrodb-migrations/snapshots/Team.snapshot.json');
    const journal = join(dir, '.electrodb-migrations/_journal.json');
    expect(existsSync(userSnap)).toBe(true);
    expect(existsSync(teamSnap)).toBe(true);
    expect(existsSync(journal)).toBe(true);

    const journalContent = JSON.parse(readFileSync(journal, 'utf8')) as {
      entries: Array<{ entity: string; snapshot: string }>;
    };
    expect(journalContent.entries.map((e) => e.entity).sort()).toEqual(['Team', 'User']);
  });

  it('second run is idempotent — snapshot file CONTENT is byte-equal (no rewrite)', async () => {
    setupProject(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runBaseline({ cwd: dir });

    const userSnapPath = join(dir, '.electrodb-migrations/snapshots/User.snapshot.json');
    const teamSnapPath = join(dir, '.electrodb-migrations/snapshots/Team.snapshot.json');
    const journalPath = join(dir, '.electrodb-migrations/_journal.json');
    const userBefore = readFileSync(userSnapPath, 'utf8');
    const teamBefore = readFileSync(teamSnapPath, 'utf8');
    const journalBefore = readFileSync(journalPath, 'utf8');

    await runBaseline({ cwd: dir });

    const userAfter = readFileSync(userSnapPath, 'utf8');
    const teamAfter = readFileSync(teamSnapPath, 'utf8');
    const journalAfter = readFileSync(journalPath, 'utf8');

    // Byte-equal CONTENT (NOT mtime — mtime granularity on HFS+/FAT32 is 1s
    // and would yield a false-positive idempotency signal on consecutive
    // sub-second invocations). Plan §Pitfall Warning 5.
    expect(userAfter).toBe(userBefore);
    expect(teamAfter).toBe(teamBefore);
    expect(journalAfter).toBe(journalBefore);
  });

  it('updates only the changed snapshot when an entity is edited; sibling snapshots stay byte-equal', async () => {
    setupProject(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runBaseline({ cwd: dir });
    const userSnapPath = join(dir, '.electrodb-migrations/snapshots/User.snapshot.json');
    const teamSnapPath = join(dir, '.electrodb-migrations/snapshots/Team.snapshot.json');
    const userFirst = readFileSync(userSnapPath, 'utf8');
    const teamFirst = readFileSync(teamSnapPath, 'utf8');

    // Modify User to trigger drift — add a new attribute.
    writeFileSync(
      join(dir, 'src/entities/user.ts'),
      `import { Entity } from 'electrodb';
       export const User = new Entity({
         model: { entity: 'User', service: 'app', version: '1' },
         attributes: {
           id: { type: 'string', required: true },
           name: { type: 'string', required: true },
           email: { type: 'string', required: false },
         },
         indexes: { primary: { pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } } },
       });`,
    );

    await runBaseline({ cwd: dir });

    const userSecond = readFileSync(userSnapPath, 'utf8');
    const teamSecond = readFileSync(teamSnapPath, 'utf8');
    expect(userSecond).not.toBe(userFirst); // changed
    expect(teamSecond).toBe(teamFirst); // unchanged — byte-equal
  });

  it('handles a project with zero entities gracefully (no throw, friendly message)', async () => {
    // Project with config but no entities/*.ts files — only an empty entities dir.
    mkdirSync(join(dir, 'src/entities'), { recursive: true });
    writeFileSync(
      join(dir, 'electrodb-migrations.config.ts'),
      `import { defineConfig } from 'electrodb-migrations';
       export default defineConfig({
         entities: 'src/entities',
         migrations: 'src/database/migrations',
         tableName: 'app_table',
       });`,
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBaseline({ cwd: dir })).resolves.toBeUndefined();

    // The message should mention "no entities" or similar.
    const allStderr = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(allStderr.toLowerCase()).toContain('no entities');
  });

  it('propagates the §5.3 invariant violation (cacheTtlMs >= acquireWaitMs) from resolveCliConfig', async () => {
    setupProject(dir);
    // Replace the config with one that violates the invariant.
    writeFileSync(
      join(dir, 'electrodb-migrations.config.ts'),
      `import { defineConfig } from 'electrodb-migrations';
       export default defineConfig({
         entities: 'src/entities',
         migrations: 'src/database/migrations',
         tableName: 'app_table',
         lock: { acquireWaitMs: 1000 },
         guard: { cacheTtlMs: 5000 },
       });`,
    );

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runBaseline({ cwd: dir })).rejects.toThrow();
  });

  it('writes a fingerprint with sha256: prefix into each snapshot', async () => {
    setupProject(dir);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runBaseline({ cwd: dir });

    const userSnap = JSON.parse(
      readFileSync(join(dir, '.electrodb-migrations/snapshots/User.snapshot.json'), 'utf8'),
    ) as { fingerprint: string; schemaVersion: number };
    expect(userSnap.fingerprint.startsWith('sha256:')).toBe(true);
    expect(userSnap.fingerprint.length).toBeGreaterThan('sha256:'.length + 16);
    expect(userSnap.schemaVersion).toBe(2);
  });
});
