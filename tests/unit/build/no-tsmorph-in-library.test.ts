import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve(__dirname, '../../../src');
const ENTRY = resolve(SRC_ROOT, 'index.ts');

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
  it('no .ts file under src/ contains "from \'ts-morph\'" except the allowlisted scaffold helper', () => {
    // Phase 2 pre-allowlists `src/scaffold/bump-entity-version.ts` ahead of
    // Plan 04. Until Plan 04 lands the file does not exist, so `offenders`
    // must be empty. Once Plan 04 introduces the single ts-morph caller,
    // it must be the SOLE entry in `offenders` — any other importer is a
    // FND-06 violation.
    const allowlistPath = resolve(SRC_ROOT, 'scaffold/bump-entity-version.ts');
    const allowlistExists = existsSync(allowlistPath);
    const expected = allowlistExists ? [allowlistPath] : [];

    const files = listSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/from\s+['"]ts-morph['"]/.test(src) || /import\(\s*['"]ts-morph['"]\s*\)/.test(src)) {
        offenders.push(f);
      }
    }
    const unexpectedOffenders = offenders.filter((f) => f !== allowlistPath);
    expect(offenders, `ts-morph imported from non-allowlisted file(s): ${unexpectedOffenders.join(', ')}`).toEqual(expected);
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
