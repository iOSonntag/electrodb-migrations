/**
 * LCK-07 / Pitfall #2 source-scan invariants for `src/lock/`.
 *
 * Plan 05 will extend the same scanner to `src/guard/` once that directory
 * exists. The third test (no inline `consistent: true`) is defense-in-depth:
 * even if a future file under `src/lock/` opts out of importing
 * `CONSISTENT_READ`, the scanner rejects the inline literal so code review
 * has a single grep target (the named import).
 */
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scanFiles, stripCommentLines } from '../../_helpers/source-scan.js';

describe('source-scan invariants for src/lock/ (LCK-07, Pitfall #2)', () => {
  it('every migrationState.get( call under src/lock/ uses consistent: CONSISTENT_READ (LCK-07)', async () => {
    // First pass: any line that calls `migrationState.get(` is a candidate.
    const candidates = await scanFiles('src/lock/**/*.ts', (line) => /migrationState\.get\(/.test(line));

    // The canonical reader (read-lock-row.ts) chains `.get(...).go(...)` on a
    // single line; the option `consistent: CONSISTENT_READ` lives on the same
    // line. For multi-line chains we widen the window to the next 3 lines.
    const violations: typeof candidates = [];
    for (const v of candidates) {
      const content = readFileSync(v.file, 'utf8').split('\n');
      // v.line is 1-indexed; slice the line itself plus the next 2.
      const window = content.slice(v.line - 1, v.line + 2).join(' ');
      if (!/consistent:\s*(?:true|CONSISTENT_READ)/.test(window)) {
        violations.push(v);
      }
    }

    expect(violations).toEqual([]);
  });

  it('no setInterval anywhere under src/lock/ outside comments (Pitfall #2)', async () => {
    const files: string[] = [];
    for await (const f of glob('src/lock/**/*.ts')) {
      files.push(f);
    }
    // The scan must observe at least one file — otherwise a relocation of
    // src/lock/ would silently make the invariant trivially green.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const stripped = stripCommentLines(readFileSync(file, 'utf8'));
      expect(stripped, `setInterval found in ${file}`).not.toMatch(/\bsetInterval\s*\(/);
    }
  });

  it('no inline `consistent: true` under src/lock/ — must use the named CONSISTENT_READ import (defense-in-depth)', async () => {
    const inlineMatches = await scanFiles('src/lock/**/*.ts', (line) => /\bconsistent:\s*true\b/.test(line), { stripComments: true });
    expect(inlineMatches).toEqual([]);
  });
});
