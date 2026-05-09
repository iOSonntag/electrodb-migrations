/**
 * Phase 6 source-scan invariant for `src/ctx/**\//*.ts`.
 *
 * RESEARCH Pitfall 1 (lines 551-555): `entity.setClient(...)` mutates the
 * user's imported entity globally. The facade strategy must use
 * `new Entity(entity.schema, { client, table })` instead. This invariant
 * makes the anti-pattern impossible to land.
 *
 * Decision per RESEARCH §Source-Scan Invariants line 920: `src/ctx/` is NOT
 * added to the `src/{lock,guard,runner,rollback}/**` glob (the CONSISTENT_READ /
 * setInterval invariants are not relevant — `src/ctx/` doesn't read the
 * lock row or schedule heartbeats). This is a separate invariant specific
 * to Phase 6.
 *
 * At Wave 0, `src/ctx/` does not exist — the glob matches zero files and the
 * assertions trivially pass. Once Wave 1 (Plans 06-02 and 06-03) land the
 * first files under `src/ctx/`, the invariant activates automatically.
 */
import { describe, expect, it } from 'vitest';
import { glob } from 'node:fs/promises';
import { scanFiles } from '../../_helpers/source-scan.js';

const SCAN_GLOB = 'src/ctx/**/*.ts';

describe('source-scan invariants for src/ctx/ (Phase 6 — Pitfall 1)', () => {
  it('no entity.setClient( call under src/ctx/ — use new Entity(schema, {client}) instead (Pitfall 1)', async () => {
    const matches = await scanFiles(SCAN_GLOB, (line) => /\.setClient\(/.test(line), { stripComments: true });
    expect(matches).toEqual([]);
  });

  it('tracker — once src/ctx/ has files, the no-setClient invariant applies automatically', async () => {
    // src/ctx/ does not exist at Wave 0; once Plans 06-02/06-03 land it, the
    // invariant above runs over each file. This tracker assertion makes the
    // glob's "did it find any files?" state visible in CI output for the planner.
    const files: string[] = [];
    for await (const f of glob(SCAN_GLOB)) {
      files.push(f);
    }
    // No assertion on count — Wave 0 has zero files; that's expected. Once
    // Wave 1 lands, the count flips above zero and the no-setClient scan
    // becomes meaningful. The tracker is informational only.
    expect(Array.isArray(files)).toBe(true);
  });
});
