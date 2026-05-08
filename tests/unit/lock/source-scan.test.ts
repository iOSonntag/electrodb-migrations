/**
 * LCK-07 / GRD-02 / Pitfall #2 source-scan invariants for `src/lock/` AND
 * `src/guard/`.
 *
 * Plan 04 created this file scanning `src/lock/` only. Plan 05 extends the
 * same scanner to `src/guard/` so the same disciplines apply to the two
 * subsystems that read the `_migration_state` row:
 *
 *   1. Every `migrationState.get(` call uses `consistent: CONSISTENT_READ`.
 *   2. No file contains `setInterval(` outside comments (Pitfall #2 — the
 *      framework's heartbeat path goes through `startHeartbeatScheduler`).
 *   3. Defense-in-depth: no inline `consistent: true` — must use the named
 *      `CONSISTENT_READ` import so code review has a single grep target.
 *
 * The third invariant is load-bearing for both subsystems: even if a future
 * file under `src/guard/` opts out of importing `CONSISTENT_READ`, the
 * scanner rejects the inline literal so the named import remains canonical.
 */
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scanFiles, stripCommentLines } from '../../_helpers/source-scan.js';

const SCAN_GLOB = 'src/{lock,guard}/**/*.ts';

describe('source-scan invariants for src/lock/ + src/guard/ (LCK-07, GRD-02, Pitfall #2)', () => {
  it('every migrationState.get( call under src/lock/ + src/guard/ uses consistent: CONSISTENT_READ (LCK-07, GRD-02)', async () => {
    // First pass: any line that calls `migrationState.get(` is a candidate.
    const candidates = await scanFiles(SCAN_GLOB, (line) => /migrationState\.get\(/.test(line));

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

  it('no setInterval anywhere under src/lock/ + src/guard/ outside comments (Pitfall #2)', async () => {
    const files: string[] = [];
    for await (const f of glob(SCAN_GLOB)) {
      files.push(f);
    }
    // The scan must observe at least one file in EACH directory — otherwise a
    // relocation of either tree would silently make the invariant trivially
    // green.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes('src/lock/'))).toBe(true);
    expect(files.some((f) => f.includes('src/guard/'))).toBe(true);
    for (const file of files) {
      const stripped = stripCommentLines(readFileSync(file, 'utf8'));
      expect(stripped, `setInterval found in ${file}`).not.toMatch(/\bsetInterval\s*\(/);
    }
  });

  it('no inline `consistent: true` under src/lock/ + src/guard/ — must use the named CONSISTENT_READ import (defense-in-depth)', async () => {
    const inlineMatches = await scanFiles(SCAN_GLOB, (line) => /\bconsistent:\s*true\b/.test(line), { stripComments: true });
    expect(inlineMatches).toEqual([]);
  });
});
