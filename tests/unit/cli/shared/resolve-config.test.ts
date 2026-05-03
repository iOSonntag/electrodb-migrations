import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCliConfig } from '../../../../src/cli/shared/resolve-config.js';
import { EDBConfigInvariantViolationError } from '../../../../src/config/invariants.js';
import { EDBConfigLoadError } from '../../../../src/config/load.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-cli-resolve-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID_CONFIG_BODY = `export default {
  entities: 'src/database/entities',
  migrations: 'src/database/migrations',
  tableName: 't',
};`;

describe('resolveCliConfig (CLI-01 — composes Phase 1 load + merge + invariants)', () => {
  it('loads with implicit cwd (no configFlag) and returns a ResolvedConfig', async () => {
    writeFileSync(join(dir, 'electrodb-migrations.config.ts'), VALID_CONFIG_BODY);
    const out = await resolveCliConfig({ cwd: dir });
    expect(out.config.tableName).toBe('t');
    expect(out.config.migrations).toBe('src/database/migrations');
    expect(out.configPath).toBe(join(dir, 'electrodb-migrations.config.ts'));
    expect(out.cwd).toBe(dir);
    // Defaults are merged.
    expect(out.config.lock.acquireWaitMs).toBeGreaterThan(0);
    expect(out.config.guard.cacheTtlMs).toBeGreaterThan(0);
  });

  it('loads with an absolute --config flag', async () => {
    const abs = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(abs, VALID_CONFIG_BODY);
    const out = await resolveCliConfig({ configFlag: abs, cwd: dir });
    expect(out.config.tableName).toBe('t');
    expect(out.configPath).toBe(abs);
  });

  it('loads with a relative --config flag (resolved against cwd)', async () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const target = join(sub, 'electrodb-migrations.config.ts');
    writeFileSync(target, VALID_CONFIG_BODY);
    const out = await resolveCliConfig({
      configFlag: 'sub/electrodb-migrations.config.ts',
      cwd: dir,
    });
    expect(out.config.tableName).toBe('t');
    expect(out.configPath).toBe(target);
  });

  it('throws when no config is found in cwd (with a remediation pointing to `init`)', async () => {
    let caught: unknown;
    try {
      await resolveCliConfig({ cwd: dir });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as Error;
    // Message names the failing condition (no config) AND the directory.
    expect(err.message).toMatch(/electrodb-migrations\.config/);
    expect(err.message).toContain(dir);
  });

  it('throws EDBConfigLoadError when an explicit absolute path does not resolve', async () => {
    const missing = join(dir, 'does-not-exist.config.ts');
    let caught: unknown;
    try {
      await resolveCliConfig({ configFlag: missing, cwd: dir });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBConfigLoadError);
  });

  it('rethrows the underlying EDBConfigLoadError when the config file throws on load', async () => {
    const path = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(path, "throw new Error('boom from config');");
    let caught: unknown;
    try {
      await resolveCliConfig({ cwd: dir });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBConfigLoadError);
    expect((caught as EDBConfigLoadError).message).toContain('boom from config');
  });

  it('rejects with EDBConfigInvariantViolationError when guard.cacheTtlMs >= lock.acquireWaitMs', async () => {
    const path = join(dir, 'electrodb-migrations.config.ts');
    writeFileSync(
      path,
      `export default {
        entities: 'src/database/entities',
        migrations: 'src/database/migrations',
        tableName: 't',
        guard: { cacheTtlMs: 99999 },
        lock: { acquireWaitMs: 1000 },
      };`,
    );
    let caught: unknown;
    try {
      await resolveCliConfig({ cwd: dir });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EDBConfigInvariantViolationError);
  });
});
