/**
 * LCK-07 / GRD-02 / RUN-01 / Pitfall #2 source-scan invariants for `src/lock/`,
 * `src/guard/`, AND `src/runner/`.
 *
 * Plan 04 created this file scanning `src/lock/` only. Plan 05 extends the
 * same scanner to `src/guard/`. Plan 04-01 extends the same scanner to
 * `src/runner/` so the same disciplines apply to the three subsystems that
 * read the `_migration_state` row (per RESEARCH §"defense-in-depth note for
 * runner/lock-row reads"):
 *
 *   1. Every `migrationState.get(` call uses `consistent: CONSISTENT_READ`.
 *   2. No file contains `setInterval(` outside comments (Pitfall #2 — the
 *      framework's heartbeat path goes through `startHeartbeatScheduler`).
 *   3. Defense-in-depth: no inline `consistent: true` — must use the named
 *      `CONSISTENT_READ` import so code review has a single grep target.
 *
 * The third invariant is load-bearing for all three subsystems: even if a
 * future file under `src/runner/` opts out of importing `CONSISTENT_READ`,
 * the scanner rejects the inline literal so the named import remains canonical.
 *
 * Note on `src/runner/` assertion: the runner directory does not exist until
 * Plan 04-07 introduces the first runner file. Until then, the glob picks up
 * zero runner files — the test stays green (glob over an empty dir returns
 * no files; the `files.length > 0` assertion covers only `src/lock/` which
 * always has files). Once Plan 04-07 lands, the invariants apply automatically.
 */
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scanFiles, stripCommentLines } from '../../_helpers/source-scan.js';

const SCAN_GLOB = 'src/{lock,guard,runner}/**/*.ts';

describe('source-scan invariants for src/lock/ + src/guard/ + src/runner/ (LCK-07, GRD-02, RUN-01, Pitfall #2)', () => {
  it('every migrationState.get( call under src/lock/ + src/guard/ + src/runner/ uses consistent: CONSISTENT_READ (LCK-07, GRD-02, RUN-01)', async () => {
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

  it('no setInterval anywhere under src/lock/ + src/guard/ + src/runner/ outside comments (Pitfall #2)', async () => {
    const files: string[] = [];
    for await (const f of glob(SCAN_GLOB)) {
      files.push(f);
    }
    // The scan must observe at least one file in EACH directory that currently
    // has source — otherwise a relocation of either tree would silently make
    // the invariant trivially green.
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes('src/lock/'))).toBe(true);
    expect(files.some((f) => f.includes('src/guard/'))).toBe(true);
    // src/runner/ existence is not asserted here — Plan 04-07 creates the first
    // file under src/runner/. Once that lands, the invariant applies to it via
    // the glob automatically.
    for (const file of files) {
      const stripped = stripCommentLines(readFileSync(file, 'utf8'));
      expect(stripped, `setInterval found in ${file}`).not.toMatch(/\bsetInterval\s*\(/);
    }
  });

  it('no inline `consistent: true` under src/lock/ + src/guard/ + src/runner/ — must use the named CONSISTENT_READ import (defense-in-depth)', async () => {
    const inlineMatches = await scanFiles(SCAN_GLOB, (line) => /\bconsistent:\s*true\b/.test(line), { stripComments: true });
    expect(inlineMatches).toEqual([]);
  });
});
