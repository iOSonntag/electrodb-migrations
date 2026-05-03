import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDBEntitySourceEditError, bumpEntityVersion } from '../../../src/scaffold/bump-entity-version.js';

const FIXTURE_ROOT = resolve(__dirname, '../../fixtures/user-entity-styles');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edbm-bump-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const dest = join(dir, `${name}.ts`);
  copyFileSync(join(FIXTURE_ROOT, `${name}.ts`), dest);
  return dest;
}

describe('bumpEntityVersion: supported styles preserve bytes outside the version literal', () => {
  it('preserves single quotes (StringLiteral)', async () => {
    const path = copyFixture('single-quote');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace("version: '1'", "version: '2'"));
  });

  it('preserves double quotes (StringLiteral)', async () => {
    const path = copyFixture('double-quote');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace('version: "1"', 'version: "2"'));
  });

  it('preserves template literals (NoSubstitutionTemplateLiteral)', async () => {
    const path = copyFixture('template-literal');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace('version: `1`', 'version: `2`'));
  });

  it('preserves numeric form (NumericLiteral)', async () => {
    const path = copyFixture('numeric-version');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace('version: 1', 'version: 2'));
  });

  it('preserves the as-const assertion (AsExpression around StringLiteral)', async () => {
    const path = copyFixture('as-const');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace("version: '1' as const", "version: '2' as const"));
  });

  it('targets only the named entity in a multi-entity file', async () => {
    const path = copyFixture('multiple-entities');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    // User's `version: '1'` becomes `'2'` (in the User entity's model block);
    // Team's `version: '1'` stays put.
    // Use a positional replacement keyed by the entity name to avoid global string replace.
    const userBlock = "{ entity: 'User', service: 'app', version: '1' }";
    const userBlockBumped = "{ entity: 'User', service: 'app', version: '2' }";
    expect(before).toContain(userBlock);
    expect(after).toBe(before.replace(userBlock, userBlockBumped));
    // Team must remain at '1'.
    expect(after).toContain("{ entity: 'Team', service: 'app', version: '1' }");
  });

  it('preserves adjacent line and block comments', async () => {
    const path = copyFixture('comments-adjacent');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace("version: '1'", "version: '2'"));
    // Belt-and-braces: assert both comment forms still present after the bump.
    expect(after).toContain('// bump me carefully');
    expect(after).toContain('/* keep this comment */');
  });

  it('preserves 4-space indentation and blank lines inside the model block', async () => {
    const path = copyFixture('multi-line-model');
    const before = readFileSync(path, 'utf8');
    await bumpEntityVersion({
      sourceFilePath: path,
      entityName: 'User',
      fromVersion: '1',
      toVersion: '2',
    });
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before.replace("version: '1'", "version: '2'"));
  });
});

describe('bumpEntityVersion: refusal cases throw EDBEntitySourceEditError without modifying source', () => {
  it('throws when version is bound to a constant identifier', async () => {
    const path = copyFixture('refused-binding');
    const before = readFileSync(path, 'utf8');
    await expect(
      bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
      }),
    ).rejects.toBeInstanceOf(EDBEntitySourceEditError);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  it('error code on the binding refusal is EDB_ENTITY_SOURCE_EDIT_ERROR', async () => {
    const path = copyFixture('refused-binding');
    let caught: unknown;
    try {
      await bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EDBEntitySourceEditError);
    expect((caught as EDBEntitySourceEditError).code).toBe('EDB_ENTITY_SOURCE_EDIT_ERROR');
    // Remediation hint must mention inlining the version literal.
    expect((caught as Error).message).toMatch(/inline the version literal/i);
    // Names the entity and the file path.
    expect((caught as Error).message).toContain('User');
    expect((caught as Error).message).toContain(path);
  });

  it('throws when the variable does not exist in the file', async () => {
    const path = copyFixture('single-quote');
    const before = readFileSync(path, 'utf8');
    await expect(
      bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'NonExistent',
        fromVersion: '1',
        toVersion: '2',
      }),
    ).rejects.toBeInstanceOf(EDBEntitySourceEditError);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  it('throws when initializer is not a `new Entity(...)` expression', async () => {
    const path = join(dir, 'not-new.ts');
    const source = `export const User = { model: { entity: 'User', service: 'app', version: '1' } };\n`;
    writeFileSync(path, source);
    const before = readFileSync(path, 'utf8');
    await expect(
      bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
      }),
    ).rejects.toBeInstanceOf(EDBEntitySourceEditError);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  it('throws when model is not an inline object literal', async () => {
    const path = join(dir, 'model-by-ref.ts');
    const source = [
      "import { Entity } from 'electrodb';",
      "const M = { entity: 'User', service: 'app', version: '1' };",
      'export const User = new Entity({ model: M, attributes: {}, indexes: {} });',
      '',
    ].join('\n');
    writeFileSync(path, source);
    const before = readFileSync(path, 'utf8');
    await expect(
      bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
      }),
    ).rejects.toBeInstanceOf(EDBEntitySourceEditError);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  it('throws when fromVersion does not match the on-disk literal value', async () => {
    const path = copyFixture('single-quote');
    const before = readFileSync(path, 'utf8');
    let caught: unknown;
    try {
      await bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '5',
        toVersion: '6',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EDBEntitySourceEditError);
    // Exact wording from RESEARCH §Pattern 3 — "Snapshot/source disagree".
    expect((caught as Error).message).toContain("is '1', expected '5'");
    expect((caught as Error).message).toMatch(/Snapshot\/source disagree/);
    const after = readFileSync(path, 'utf8');
    expect(after).toBe(before);
  });

  it('throws on unsupported file extensions (.cjs)', async () => {
    const path = join(dir, 'user.cjs');
    const source = "module.exports = { User: 'placeholder' };\n";
    writeFileSync(path, source);
    let caught: unknown;
    try {
      await bumpEntityVersion({
        sourceFilePath: path,
        entityName: 'User',
        fromVersion: '1',
        toVersion: '2',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EDBEntitySourceEditError);
    expect((caught as Error).message).toMatch(/\.ts user entity files only/);
    // Source unchanged.
    expect(readFileSync(path, 'utf8')).toBe(source);
  });
});
