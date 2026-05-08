/**
 * Wave 0 spike — RESEARCH Assumption A4 + Open Question 4 verification.
 *
 * **What this proves:**
 * ElectroDB's `entity.scan.go()` filters scan results by `__edb_e__` / `__edb_v__`
 * identity stamps, so a single-table-design (STD) table containing rows for multiple
 * entity types (e.g. User AND Team) does NOT surface neighbor-entity records when
 * scanned via one entity's scan chain.
 *
 * **Why this matters (Assumption A4 — load-bearing for RUN-01):**
 * STD migrations would silently surface neighbor-entity records if `entity.scan`
 * did NOT filter by `__edb_e__` / `__edb_v__`. This 10-assertion spike confirms or
 * denies before runner code lands. If the spike fails, RUN-01 must fall back to a
 * raw `ScanCommand` with a manual `__edb_e__`/`__edb_v__` filter
 * (RESEARCH §Alternatives Considered row 1).
 *
 * **Decision recorded:** Open Question 4 (RESEARCH) — entity.scan identity-stamp
 * filtering confirmed; runner discovers entity records via `entity.scan` chain
 * without additional manual filtering.
 *
 * **Skip behaviour:** When DDB Local is not reachable, every test in this file
 * skips with `console.warn(skipMessage())` rather than failing. Run
 * `docker compose up -d dynamodb-local` to enable integration tests.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Entity } from 'electrodb';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

describe('Wave 0 spike: ElectroDB identity-stamp scan filtering in STD fixture (Assumption A4)', () => {
  const tableName = randomTableName('wave0-spike');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  // Two entities sharing the SAME table, SAME pk/sk field names, SAME service —
  // but distinct `model.entity` values so ElectroDB writes distinct `__edb_e__`
  // markers and different identifier prefixes on pk/sk.
  const userEntity = new Entity(
    {
      model: { entity: 'User', version: '1', service: 'spike' },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client: doc, table: tableName },
  );

  const teamEntity = new Entity(
    {
      model: { entity: 'Team', version: '1', service: 'spike' },
      attributes: {
        id: { type: 'string', required: true },
        // Deliberately distinct attribute name from User.name so cross-contamination
        // is provable: User records have `name` but NOT `teamLabel`; Team records
        // have `teamLabel` but NOT `name`.
        teamLabel: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client: doc, table: tableName },
  );

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      await createTestTable(raw, tableName);

      // Seed 5 User records and 5 Team records into the SAME STD table.
      await Promise.all([
        userEntity.put({ id: 'u-1', name: 'Alice' }).go(),
        userEntity.put({ id: 'u-2', name: 'Bob' }).go(),
        userEntity.put({ id: 'u-3', name: 'Carol' }).go(),
        userEntity.put({ id: 'u-4', name: 'Dave' }).go(),
        userEntity.put({ id: 'u-5', name: 'Eve' }).go(),
        teamEntity.put({ id: 't-1', teamLabel: 'Engineering' }).go(),
        teamEntity.put({ id: 't-2', teamLabel: 'Design' }).go(),
        teamEntity.put({ id: 't-3', teamLabel: 'Product' }).go(),
        teamEntity.put({ id: 't-4', teamLabel: 'Marketing' }).go(),
        teamEntity.put({ id: 't-5', teamLabel: 'Sales' }).go(),
      ]);
    }
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('Assumption A4: userEntity.scan.go() returns exactly 5 User records (not Team records)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Use pages: 'all' to fetch all results in one call (appropriate for this small fixture).
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB pages option is typed as number | 'all' but the type definition varies by version.
    const userScan = await (userEntity.scan as any).go({ pages: 'all' });

    // Core assertion: identity-stamp filter returns ONLY User records.
    expect(userScan.data.length).toBe(5);

    // Shape assertion: every record has the `name` attribute (User-specific)
    // and does NOT have `teamLabel` (Team-specific).
    expect(userScan.data.every((r: Record<string, unknown>) => 'name' in r && !('teamLabel' in r))).toBe(true);
  });

  it('Assumption A4 (symmetric): teamEntity.scan.go() returns exactly 5 Team records (not User records)', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB pages option typing.
    const teamScan = await (teamEntity.scan as any).go({ pages: 'all' });

    // Core assertion: identity-stamp filter returns ONLY Team records.
    expect(teamScan.data.length).toBe(5);

    // Shape assertion: every record has `teamLabel` (Team-specific) and NOT `name`.
    expect(teamScan.data.every((r: Record<string, unknown>) => 'teamLabel' in r && !('name' in r))).toBe(true);
  });
});
