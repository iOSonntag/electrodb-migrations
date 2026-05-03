import { describe, expect, it } from 'vitest';
import { renderMigrationTemplate } from '../../../src/scaffold/templates.js';

/**
 * Plan 02-07 Task 1 — `renderMigrationTemplate` byte-equal contract.
 *
 * The output must match README §4/§5 (lines 106-119) byte-for-byte
 * after substituting `<migrationId>` and `<EntityName>`. The function
 * is pure and deterministic.
 */
describe('renderMigrationTemplate', () => {
  it('byte-equal happy path — README §4 quick-start example', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });

    const expected = [
      "import { defineMigration } from 'electrodb-migrations';",
      "import { User as UserV1 } from './v1.js';",
      "import { User as UserV2 } from './v2.js';",
      '',
      'export default defineMigration({',
      "  id: '20260501083000-User-add-status',",
      "  entityName: 'User',",
      '  from: UserV1,',
      '  to: UserV2,',
      '  up: async (record) => {',
      '    // TODO: implement the v1 → v2 transform',
      "    throw new Error('up() not implemented');",
      '  },',
      '  // down: async (record) => { /* optional, required for post-finalize rollback */ },',
      '});',
      '',
    ].join('\n');

    expect(out).toBe(expected);
  });

  it('output ends with a trailing newline', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('output contains no CRLF line endings', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });
    expect(out.includes('\r')).toBe(false);
  });

  it('determinism — same args produce byte-equal output across calls', () => {
    const args = {
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    };
    const a = renderMigrationTemplate(args);
    const b = renderMigrationTemplate(args);
    expect(a).toBe(b);
  });

  it('interpolates a different entityName verbatim (PascalCase)', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-Team-add-color',
      entityName: 'Team',
    });
    expect(out).toContain("import { Team as TeamV1 } from './v1.js';");
    expect(out).toContain("import { Team as TeamV2 } from './v2.js';");
    expect(out).toContain('  from: TeamV1,');
    expect(out).toContain('  to: TeamV2,');
    expect(out).toContain("  entityName: 'Team',");
  });

  it('interpolates a different migrationId', () => {
    const out = renderMigrationTemplate({
      migrationId: '20990101000000-Team-rename-pk',
      entityName: 'Team',
    });
    expect(out).toContain("  id: '20990101000000-Team-rename-pk',");
  });

  it('preserves snake_case entityName verbatim (no PascalCase coercion)', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-account_holder-add-status',
      entityName: 'account_holder',
    });
    expect(out).toContain("import { account_holder as account_holderV1 } from './v1.js';");
    expect(out).toContain("import { account_holder as account_holderV2 } from './v2.js';");
    expect(out).toContain('  from: account_holderV1,');
    expect(out).toContain('  to: account_holderV2,');
  });

  it('imports the defineMigration symbol from the bare specifier', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });
    expect(out).toContain("import { defineMigration } from 'electrodb-migrations';");
  });

  it('contains a TODO marker on the up() body', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });
    expect(out).toContain('// TODO: implement the v1 → v2 transform');
  });

  it('contains a commented-out down() placeholder', () => {
    const out = renderMigrationTemplate({
      migrationId: '20260501083000-User-add-status',
      entityName: 'User',
    });
    expect(out).toMatch(/\/\/ down: async \(record\) => \{ \/\* optional, required for post-finalize rollback \*\/ \},/);
  });
});
