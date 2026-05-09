import type { AnyElectroEntity, Migration } from '../migrations/index.js';

/**
 * Per-page hook + tuning for {@link iterateV1Records}.
 *
 * `pageSize` defaults to 100 (DDB returns up to 1MB per page; with typical
 * record size 200B-2KB that maps to 500-5000 records — capping at 100
 * keeps memory bounded and gives the heartbeat tick frequency).
 *
 * `onPage` runs AFTER each page yield. Plan 08's apply-flow uses this to
 * give the event loop a tick so the heartbeat scheduler's setTimeout
 * fires even if user `up()` is CPU-bound.
 */
export interface IterateV1RecordsOptions {
  pageSize?: number;
  onPage?: () => void | Promise<void>;
}

/**
 * RUN-01 — iterate v1 records via the migration's frozen v1 ElectroDB
 * entity. Cursor-based pagination; yields one page (record array) per
 * iteration.
 *
 * **Identity-stamp filtering:** ElectroDB's `entity.scan.go(...)` returns
 * only records whose `__edb_e__`/`__edb_v__` markers match the entity's
 * model — single-table-design safe. Plan 04-01 Wave 0 spike confirmed
 * this on DDB Local (Assumption A4: CONFIRMED).
 *
 * **Memory:** Buffers AT MOST one page (≤`pageSize` records) in memory.
 * Million-row migrations don't OOM.
 *
 * **Consistency:** Pages are read with `consistent: true`. The migration's
 * correctness depends on seeing every v1 record before finalize reaps them;
 * an eventually-consistent scan could miss an in-flight write that hadn't
 * propagated yet, leaving an orphan v1 record that finalize would later
 * delete. DynamoDB does not support strongly-consistent scans on GSIs, so
 * this requires the v1 entity's primary index to be the table's primary
 * key — which is the canonical ElectroDB pattern (WR-09).
 */
export async function* iterateV1Records(
  migration: Migration<AnyElectroEntity, AnyElectroEntity>,
  options: IterateV1RecordsOptions = {},
): AsyncGenerator<readonly Record<string, unknown>[]> {
  const limit = options.pageSize ?? 100;
  const v1 = migration.from as unknown as {
    scan: {
      go: (opts: {
        cursor?: string | null;
        limit?: number;
        consistent?: boolean;
      }) => Promise<{ data: Record<string, unknown>[]; cursor: string | null }>;
    };
  };
  let cursor: string | null = null;
  do {
    const page = await v1.scan.go({ cursor, limit, consistent: true });
    if (page.data.length > 0) yield page.data;
    cursor = page.cursor;
    if (options.onPage) await options.onPage();
  } while (cursor !== null);
}
