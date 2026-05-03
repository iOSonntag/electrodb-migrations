import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(__dirname, '../../../src');
const ENTRY = resolve(SRC_ROOT, 'index.ts');

/**
 * The single src/ file allowed to import ts-morph. Lazy-loaded by the scaffold
 * orchestrator (Plan 07) via dynamic `await import('./bump-entity-version.js')`,
 * so the ts-morph closure stays out of the library bundle (FND-06). Any other
 * file importing ts-morph is a regression and breaks this invariant.
 *
 * Path written with the platform-native separator so the comparison works on
 * both POSIX and Windows.
 */
const ALLOWLISTED_TSMORPH_FILES = new Set<string>([resolve(SRC_ROOT, `scaffold${sep}bump-entity-version.ts`)]);

/** Recursively walk src/ and return every .ts file path. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (st.isFile() && extname(full) === '.ts') out.push(full);
  }
  return out;
}

describe('FND-06: ts-morph must not appear in the library bundle', () => {
  it('no .ts file under src/ (outside the allowlist) contains "from \'ts-morph\'"', () => {
    const files = listSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWLISTED_TSMORPH_FILES.has(f)) continue;
      const src = readFileSync(f, 'utf8');
      if (/from\s+['"]ts-morph['"]/.test(src) || /import\(\s*['"]ts-morph['"]\s*\)/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders, `ts-morph imported from non-allowlisted file(s): ${offenders.join(', ')}`).toEqual([]);
  });

  it('the allowlisted file (src/scaffold/bump-entity-version.ts) actually imports ts-morph', () => {
    // Defensive: if the file ever moves or stops importing ts-morph, this
    // surfaces it before the allowlist silently becomes a no-op.
    const allowlistedPath = resolve(SRC_ROOT, `scaffold${sep}bump-entity-version.ts`);
    if (!existsSync(allowlistedPath)) return; // Pre-Plan 02-04 state — explicitly OK.
    const src = readFileSync(allowlistedPath, 'utf8');
    expect(src).toMatch(/from\s+['"]ts-morph['"]/);
  });

  it('src/index.ts does not contain any ts-morph reference', () => {
    if (!existsSync(ENTRY)) {
      // Pre-Plan 09 (Phase 1) state — explicitly OK.
      return;
    }
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).not.toMatch(/ts-morph/);
  });
});
