/**
 * RBK-11 STD safety integration test — proves that the `classifyTypeTable`
 * generator does NOT emit Team records when User and Team coexist in the
 * same single-table-design (STD) table.
 *
 * **Why this test is load-bearing:**
 * The type-table classifier power comes from ElectroDB's identity-stamp
 * filtering (`entity.scan` only returns records whose `__edb_e__`/`__edb_v__`
 * match THAT entity). A naive type-table that scanned by raw (pk, sk) ranges
 * would mis-classify Team records as User records when both share the same
 * `pk` prefix pattern. This test proves the correct behavior end-to-end
 * against real DDB Local.
 *
 * **Test setup:**
 * - User fixture (User-and-Team-std): 3 Type A + 2 Type B + 2 Type C = 7 User records.
 * - 5 additional Team records in the SAME table.
 * - Classifier runs against the User migration (entity: 'User').
 * - Expected: exactly 7 entries (3 A + 2 B + 2 C), ZERO Team records.
 *
 * Reference: Plan 05-03 (RBK-11), RESEARCH §Section 2 STD safety, §Pitfall 2.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyTypeTable } from '../../../src/rollback/type-table.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/docker-availability.js';
import { setupRollbackTestTable, type RollbackTestTableSetup } from './_helpers.js';

describe('RBK-11 — STD safety: classifyTypeTable does not emit Team records', () => {
  let setup: RollbackTestTableSetup;
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'std',
      seed: {
        mixed: { aCount: 3, bCount: 2, cCount: 2 },
      },
    });

    // Seed 5 Team records into the SAME table as the User records.
    // These should be invisible to the User classifier.
    await Promise.all([
      setup.teamEntity.put({ id: 't-1', teamLabel: 'Engineering' }).go(),
      setup.teamEntity.put({ id: 't-2', teamLabel: 'Design' }).go(),
      setup.teamEntity.put({ id: 't-3', teamLabel: 'Product' }).go(),
      setup.teamEntity.put({ id: 't-4', teamLabel: 'Marketing' }).go(),
      setup.teamEntity.put({ id: 't-5', teamLabel: 'Sales' }).go(),
    ]);
  }, 30_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('classifier emits exactly 7 entries (3 A + 2 B + 2 C) with no Team records', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const entries: Awaited<ReturnType<typeof classifyTypeTable extends AsyncGenerator<infer T> ? () => T : never>>[] = [];
    for await (const entry of classifyTypeTable({ migration: setup.migration })) {
      entries.push(entry);
    }

    // Count assertions.
    expect(entries.filter((e) => e.type === 'A').length).toBe(3);
    expect(entries.filter((e) => e.type === 'B').length).toBe(2);
    expect(entries.filter((e) => e.type === 'C').length).toBe(2);
    expect(entries).toHaveLength(7);
  });

  it('no entry contains Team-shaped data (teamLabel field)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const entries: Awaited<ReturnType<typeof classifyTypeTable extends AsyncGenerator<infer T> ? () => T : never>>[] = [];
    for await (const entry of classifyTypeTable({ migration: setup.migration })) {
      entries.push(entry);
    }

    // Assert no entry has teamLabel in any of its record shapes.
    expect(
      entries.every((e) => !('teamLabel' in (e.v1Original ?? e.v2 ?? {}))),
    ).toBe(true);
  });

  it('Team records in the table are unchanged after classification (classifier is read-only)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // The classifier only reads — it must not touch Team records.
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB pages option
    const teamScan = await (setup.teamEntity.scan as any).go({ pages: 'all' });
    expect(teamScan.data.length).toBe(5);
  });
});
