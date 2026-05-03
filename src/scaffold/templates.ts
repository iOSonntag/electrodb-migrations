/**
 * Migration.ts stub builder. SCF-03 (Phase 2 Plan 07).
 *
 * Output matches README §4/§5 (lines 106-119) byte-for-byte after
 * substituting the migrationId and entityName. Pure deterministic
 * function over (migrationId, entityName); no I/O, no closures, no
 * external state.
 *
 * Newline discipline: LF only (`\n`); a trailing newline at end of
 * file. The output is parseable as TypeScript — `import` lines use
 * `.js` relative-import extensions per RESEARCH §Pattern 4 ("Why
 * `.js` import extensions in the migration template").
 *
 * The renderer is unopinionated about entityName casing: PascalCase,
 * snake_case, kebab-case all flow through verbatim. Validation of
 * entityName (path-traversal, identifier-shape) is the caller's job
 * and already happens upstream in `createMigrationId` (Plan 03).
 *
 * Consumed by Plan 07's `scaffoldCreate` orchestrator alongside
 * `renderFrozenEntitySource` (v1.ts / v2.ts).
 */

export interface RenderMigrationTemplateArgs {
  /** Folder name without trailing slash, e.g. `'20260501083000-User-add-status'`. */
  migrationId: string;
  /** Top-level entity binding (matches the `export const <name>` of v1.ts/v2.ts). */
  entityName: string;
}

/**
 * Render the migration.ts stub for a freshly scaffolded migration folder.
 *
 * @returns Source text ending in a single trailing `\n`, no CR characters.
 */
export function renderMigrationTemplate(args: RenderMigrationTemplateArgs): string {
  const { migrationId, entityName } = args;
  const lines = [
    "import { defineMigration } from 'electrodb-migrations';",
    `import { ${entityName} as ${entityName}V1 } from './v1.js';`,
    `import { ${entityName} as ${entityName}V2 } from './v2.js';`,
    '',
    'export default defineMigration({',
    `  id: '${migrationId}',`,
    `  entityName: '${entityName}',`,
    `  from: ${entityName}V1,`,
    `  to: ${entityName}V2,`,
    '  up: async (record) => {',
    '    // TODO: implement the v1 → v2 transform',
    "    throw new Error('up() not implemented');",
    '  },',
    '  // down: async (record) => { /* optional, required for post-finalize rollback */ },',
    '});',
  ];
  return `${lines.join('\n')}\n`;
}
