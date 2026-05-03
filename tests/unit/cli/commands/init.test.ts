import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../../../src/cli/commands/init.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-init-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runInit (INI-01 + INI-02)', () => {
  it('creates the framework state dirs and the default config file (INI-01 happy path)', async () => {
    // Silence stderr noise from log.ok / log.info
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runInit({ cwd: dir, force: false });
    expect(existsSync(join(dir, '.electrodb-migrations'))).toBe(true);
    expect(existsSync(join(dir, '.electrodb-migrations/snapshots'))).toBe(true);
    expect(existsSync(join(dir, 'src/database/migrations'))).toBe(true);
    expect(existsSync(join(dir, 'electrodb-migrations.config.ts'))).toBe(true);
    const config = readFileSync(join(dir, 'electrodb-migrations.config.ts'), 'utf8');
    expect(config).toContain("import { defineConfig } from 'electrodb-migrations'");
    expect(config).toContain("entities: 'src/database/entities'");
    expect(config).toContain("migrations: 'src/database/migrations'");
    expect(config).toContain('tableName:');
  });

  it('does NOT create a starter entity file (Q6 locked — keep init pure)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runInit({ cwd: dir, force: false });
    // src/database/entities should NOT exist or, if it exists, must be empty.
    const entitiesDir = join(dir, 'src/database/entities');
    if (existsSync(entitiesDir)) {
      const fs = await import('node:fs');
      const items = fs.readdirSync(entitiesDir);
      expect(items).toHaveLength(0);
    }
  });

  it('refuses without --force when config already exists (INI-02)', async () => {
    writeFileSync(join(dir, 'electrodb-migrations.config.ts'), '// custom');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runInit({ cwd: dir, force: false })).rejects.toThrow(/already exists/);
    // Custom content preserved
    expect(readFileSync(join(dir, 'electrodb-migrations.config.ts'), 'utf8')).toBe('// custom');
  });

  it('overwrites the config when --force is set (INI-02)', async () => {
    writeFileSync(join(dir, 'electrodb-migrations.config.ts'), '// custom');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runInit({ cwd: dir, force: true });
    const config = readFileSync(join(dir, 'electrodb-migrations.config.ts'), 'utf8');
    expect(config).not.toBe('// custom');
    expect(config).toContain('defineConfig');
  });

  it('--force preserves snapshots and migration folders (only config is overwritten)', async () => {
    // Pre-existing user data
    mkdirSync(join(dir, '.electrodb-migrations/snapshots'), { recursive: true });
    writeFileSync(join(dir, '.electrodb-migrations/snapshots/User.snapshot.json'), '{"existing":"snapshot"}');
    mkdirSync(join(dir, 'src/database/migrations/some-old-migration'), { recursive: true });
    writeFileSync(join(dir, 'src/database/migrations/some-old-migration/v1.ts'), '// pre-existing migration');
    writeFileSync(join(dir, 'electrodb-migrations.config.ts'), '// custom');

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runInit({ cwd: dir, force: true });

    // Snapshot preserved
    expect(readFileSync(join(dir, '.electrodb-migrations/snapshots/User.snapshot.json'), 'utf8')).toBe('{"existing":"snapshot"}');
    // Migration preserved
    expect(readFileSync(join(dir, 'src/database/migrations/some-old-migration/v1.ts'), 'utf8')).toBe('// pre-existing migration');
    // Config overwritten
    expect(readFileSync(join(dir, 'electrodb-migrations.config.ts'), 'utf8')).toContain('defineConfig');
  });

  it('is idempotent for directory creation (running twice with --force is fine)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runInit({ cwd: dir, force: false });
    await runInit({ cwd: dir, force: true });
    expect(existsSync(join(dir, '.electrodb-migrations/snapshots'))).toBe(true);
    expect(existsSync(join(dir, 'src/database/migrations'))).toBe(true);
    expect(existsSync(join(dir, 'electrodb-migrations.config.ts'))).toBe(true);
  });
});
