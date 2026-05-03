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
  it('no .ts file under src/ contains "from \'ts-morph\'"', () => {
    const files = listSourceFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/from\s+['"]ts-morph['"]/.test(src) || /import\(\s*['"]ts-morph['"]\s*\)/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders, `ts-morph imported from: ${offenders.join(', ')}`).toEqual([]);
  });

  it('src/index.ts does not exist yet (Phase 1 Plan 09 will create it) OR exists and contains no ts-morph reference', () => {
    if (!existsSync(ENTRY)) {
      // Wave 0 / pre-Plan 09 state — explicitly OK.
      return;
    }
    const src = readFileSync(ENTRY, 'utf8');
    expect(src).not.toMatch(/ts-morph/);
  });
});
