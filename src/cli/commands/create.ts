import { relative } from 'node:path';
import type { Command } from 'commander';
import { renderSchemaDiff } from '../../drift/diff.js';
import { type EntityMetadata, discoverEntityFiles, extractEntityMetadata, loadEntityFile } from '../../user-entities/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

/**
 * `create` command — the user-facing entry that wires Plans 02, 03, 07, 08
 * into the README §4 happy path. SCF-01.
 *
 * Plan 09 is intentionally a thin orchestrator:
 *   1. Resolve the user's config (Plan 05's resolveCliConfig).
 *   2. Discover + load + inspect every entity (Plan 08).
 *   3. Match the named entity (case-sensitive on the export key); on miss,
 *      compute a Levenshtein-distance "Did you mean" suggestion.
 *   4. Dynamic-import the scaffold orchestrator (Plan 07). The dynamic
 *      `import('../../scaffold/create.js')` is the single FND-06 lazy chain
 *      site for the CLI: commands/create -> scaffold/create -> bump-entity-version.
 *      Keeping ts-morph behind that chain is what lets the LIBRARY bundle
 *      stay free of ts-morph (verified by tests/unit/build/no-tsmorph-in-library.test.ts).
 *   5. Render the colored schema diff (Plan 02's renderSchemaDiff backed by
 *      Plan 05's `c` Colorizer).
 *   6. Log success summary + the migration folder path.
 *
 * Error matrix (all carry the operator-actionable message + remediation):
 *   - EDB_DRIFT_NOT_DETECTED (no shape drift, --force absent)  -> exit 2
 *   - EDB_ENTITY_SOURCE_EDIT_ERROR (ts-morph bump refused)    -> exit 1, with
 *     recovery hint that the migration folder DID land but the source
 *     was NOT bumped.
 *   - EDB_USER_ENTITY_LOAD_ERROR (jiti load failure)          -> exit 1
 *   - generic Error                                            -> exit 1
 *
 * Discrimination is via `err.code === '...'` (string compare, not
 * `instanceof`) so the static import graph never references the internal
 * error classes — keeping them off the public surface.
 */

/**
 * Two-row Levenshtein distance for the "Did you mean ...?" suggestion when
 * the user passes `--entity` that does not match any defined entity.
 * Pitfall #5 from RESEARCH lines 668-678. Standard edit-distance with the
 * O(min(a, b)) memory footprint; ~20 lines, no new dependency.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // biome-ignore lint/style/noNonNullAssertion: array bounds guaranteed by loop conditions.
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  // biome-ignore lint/style/noNonNullAssertion: prev[b.length] is in bounds by construction.
  return prev[b.length]!;
}

export interface RunCreateArgs {
  cwd: string;
  /** Path passed via the global `--config <path>` flag, when provided. */
  configFlag?: string;
  /** Required: the entity name to scaffold a migration for. */
  entity: string;
  /** Required: the migration slug (sanitized inside createMigrationId). */
  name: string;
  /** Bypass the no-drift refusal gate (SCF-07). */
  force: boolean;
  /** Injected clock (epoch ms) — pinned in tests. */
  clock?: () => number;
}

/**
 * Run the user-facing `create` flow. Throws on operator-fixable failures
 * with `.remediation` attached when the wrapping action handler should
 * format the CLI-09 dim-arrow second line; calls `process.exit` directly
 * for the cases where the exit code matters (DRIFT_NOT_DETECTED -> 2 vs
 * USER_ERROR -> 1) and the error class needs to be discriminated by code.
 */
export async function runCreate(args: RunCreateArgs): Promise<void> {
  const { config, cwd } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  // 1. Discover + load + inspect every entity. Mirrors baseline's first half.
  const files = await discoverEntityFiles({ cwd, entitiesConfig: config.entities });
  const allMetas: EntityMetadata[] = [];
  for (const f of files) {
    const mod = await loadEntityFile(f);
    allMetas.push(...extractEntityMetadata(mod, f));
  }

  // 2. Find the named entity (case-sensitive on the export key).
  const meta = allMetas.find((m) => m.entityName === args.entity);
  if (!meta) {
    const available = allMetas.map((m) => m.entityName);
    const suggestions = available.filter((n) => levenshtein(n, args.entity) <= 2);
    const lines: string[] = [`Entity '${args.entity}' not found.`];
    if (available.length > 0) lines.push(`Available entities: ${available.join(', ')}.`);
    if (suggestions.length > 0 && suggestions[0] !== undefined) lines.push(`Did you mean '${suggestions[0]}'?`);
    const err = new Error(lines.join(' '));
    Object.assign(err, { remediation: 'Define the entity in your config.entities directory or fix the --entity argument.' });
    throw err;
  }

  // 3. Pre-compute fromVersion / toVersion for the diff rendering. Mirrors
  // scaffold/create.ts's own derivation so the rendered diff header matches
  // what the orchestrator wrote into the migration folder. Numeric coercion
  // is intentional — non-numeric versions surface as a scaffoldCreate error
  // before we ever render the diff.
  const fromVersion = String(meta.modelVersion);
  const fromVersionNum = Number(fromVersion);
  const toVersion = Number.isNaN(fromVersionNum) ? fromVersion : String(fromVersionNum + 1);

  // 4. Dynamic import (FND-06 lazy chain). The path string is a literal —
  // tsc resolves it at typecheck time, but bundlers split it out of the
  // static graph so ts-morph (transitively reached via scaffold/create's
  // own dynamic import) stays out of the library bundle.
  const { scaffoldCreate } = await import('../../scaffold/create.js');

  try {
    const result = await scaffoldCreate({
      cwd,
      migrationsDir: config.migrations,
      entityName: meta.entityName,
      slug: args.name,
      currentEntityModel: (meta.entityInstance as { model: unknown }).model,
      sourceFilePath: meta.sourceFilePath,
      force: args.force,
      clock: args.clock ?? Date.now,
    });

    // 5. Schema diff to stderr (the diff is operator-facing prose, not
    // machine-readable; stdout stays reserved for future --json modes).
    const diff = renderSchemaDiff(result.drifts, {
      entityName: meta.entityName,
      fromVersion,
      toVersion,
      colorize: c,
    });
    process.stderr.write(`\n${diff}\n`);

    // 6. Success summary lines (README §4 quick-start format).
    if (result.drifts.length > 0) {
      log.ok(`Found ${result.drifts.length} drift record${result.drifts.length === 1 ? '' : 's'} for entity '${meta.entityName}'`);
    }
    log.ok(`Generated migration folder: ${relative(cwd, result.migrationFolderPath)}`);
    log.ok(`Bumped ${meta.entityName}.model.version: '${fromVersion}' -> '${toVersion}'`);
    log.ok(`Updated snapshot for ${meta.entityName}`);
  } catch (err) {
    // Discrimination via `.code` rather than `instanceof` to avoid pulling
    // EDBDriftNotDetectedError / EDBEntitySourceEditError into the static
    // import graph (FORBIDDEN_RUNTIME_KEYS in tests/unit/build/public-surface.test.ts).
    const code = (err as { code?: string }).code;
    if (code === 'EDB_DRIFT_NOT_DETECTED') {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(message);
      process.exit(EXIT_CODES.DRIFT_NOT_DETECTED);
    }
    if (code === 'EDB_ENTITY_SOURCE_EDIT_ERROR') {
      const message = err instanceof Error ? err.message : String(err);
      log.err(
        message,
        'The migration folder was scaffolded but the entity source was NOT bumped. Recover by running `rm -rf <migration-folder>` and resolving the inline-literal issue, then re-run `create`.',
      );
      process.exit(EXIT_CODES.USER_ERROR);
    }
    if (code === 'EDB_USER_ENTITY_LOAD_ERROR') {
      const message = err instanceof Error ? err.message : String(err);
      log.err(message, 'Check the syntax of your entity file or run `electrodb-migrations init` to scaffold a fresh config.');
      process.exit(EXIT_CODES.USER_ERROR);
    }
    // Generic surface — re-throw so registerCreateCommand's wrapper
    // formats the CLI-09 remediation suffix uniformly.
    throw err;
  }
}

/**
 * Register the `create` subcommand on the commander program. Mirrors the
 * registerXCommand pattern from init.ts and baseline.ts:
 *  - subcommand-specific options (--entity, --name, --force) are declared
 *    here, the global --config is read off the program's options.
 *  - the action handler unwraps args, calls `runCreate`, and on a thrown
 *    error formats the CLI-09 dim-arrow remediation second line via
 *    `log.err(message, remediation)` then exits with USER_ERROR.
 */
export function registerCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Scaffold a migration for an entity that has shape drift')
    .requiredOption('--entity <name>', 'Entity name (must match a defined entity)')
    .requiredOption('--name <slug>', 'Migration slug (e.g. add-status)')
    .option('-f, --force', 'Scaffold even when no shape drift detected', false)
    .action(async (opts: { entity: string; name: string; force?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runCreate({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          entity: opts.entity,
          name: opts.name,
          force: opts.force ?? false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
