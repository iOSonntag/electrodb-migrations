import { readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * The single allowed entity-file extension. v0.1 supports `.ts` only — `.js`,
 * `.cjs`, `.mjs` are out of scope (RESEARCH §Pattern 3 edge cases). Bumping
 * this to a multi-extension allowlist is a Phase 4+ decision.
 */
const ENTITY_FILE_EXT = '.ts';

/**
 * Suffixes that are always excluded even when they end in `.ts`. Test files
 * and ambient declarations are not entity definitions.
 */
const EXCLUDED_SUFFIXES = ['.test.ts', '.spec.ts', '.d.ts'] as const;

/**
 * Directory names that are never traversed during recursive discovery.
 * `node_modules` would explode the walk; `.git`, `dist`, `build` are
 * package artifacts that cannot legitimately house user entity definitions.
 * T-02-08-04 mitigation.
 */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

export interface DiscoverEntityFilesArgs {
  /** Working directory used to resolve cwd-relative entries. */
  cwd: string;
  /**
   * The user's `config.entities` value: a single path or an array. Each entry
   * may resolve to a directory (recursed) or to a single file.
   */
  entitiesConfig: string | readonly string[];
}

/**
 * Walk `entitiesConfig` and return every entity-shaped `.ts` file as an
 * absolute path. Throws if any configured entry does not exist (the caller
 * — Plan 09's `create` and Plan 08's `baseline` — wraps this with a
 * user-friendly remediation message).
 *
 * - Directory entries are recursed (skipping EXCLUDED_DIRS, EXCLUDED_SUFFIXES).
 * - File entries are taken directly when they end in `.ts` and pass the
 *   exclusion filter.
 * - The result is alphabetically sorted (deterministic) and deduplicated
 *   (a file reachable via two array entries appears once).
 *
 * Implementation note: this is the "tiny recursive walker" recommended by
 * RESEARCH §Don't Hand-Roll over `glob`/`fast-glob` — the surface is small
 * enough that an explicit walk is more legible than a glob dependency.
 */
export async function discoverEntityFiles(args: DiscoverEntityFilesArgs): Promise<string[]> {
  const entries = typeof args.entitiesConfig === 'string' ? [args.entitiesConfig] : args.entitiesConfig;
  const out = new Set<string>();
  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : resolve(args.cwd, entry);
    // Hard-skip explicit entries that point at an EXCLUDED_DIRS name. Honors
    // the "never traverse node_modules" invariant even when the operator
    // explicitly passes it (T-02-08-04 — DoS via giant trees).
    if (EXCLUDED_DIRS.has(basename(abs))) continue;
    // statSync throws ENOENT for missing paths — let it propagate; the caller
    // wraps it with command-shaped remediation (CLI-09).
    const stat = statSync(abs);
    if (stat.isFile()) {
      if (isEntityCandidate(abs)) {
        out.add(abs);
      }
      continue;
    }
    if (stat.isDirectory()) {
      collectTsFilesRecursive(abs, out);
    }
  }
  return [...out].sort();
}

function isEntityCandidate(filePath: string): boolean {
  if (!filePath.endsWith(ENTITY_FILE_EXT)) return false;
  for (const suffix of EXCLUDED_SUFFIXES) {
    if (filePath.endsWith(suffix)) return false;
  }
  return true;
}

function collectTsFilesRecursive(dir: string, out: Set<string>): void {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFilesRecursive(full, out);
    } else if (st.isFile() && isEntityCandidate(full)) {
      out.add(full);
    }
  }
}
