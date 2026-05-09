/**
 * Type-table classifier — the safety-critical module that powers every
 * Case 2 / Case 3 rollback strategy (RBK-04 + RBK-11).
 *
 * Performs two identity-stamp-filtered scans (v1 then v2) through the
 * migration's frozen ElectroDB entities and unions the results by
 * user-domain key into four cell types:
 *
 *   - **Type A**: record present as both v1 AND v2 (most common post-apply).
 *   - **Type B**: record present as v2 ONLY (created after apply, no v1 counterpart).
 *   - **Type C**: record present as v1 ONLY (deleted on the app side post-apply).
 *   - **Type D**: unreachable by construction (D = "neither" — only scanned records).
 *
 * **STD safety (RBK-11):** Each `entity.scan` call only returns records whose
 * `(__edb_e__, __edb_v__)` markers match THAT entity (e.g. User v1). Team
 * records on the same `pk` prefix are filtered out by ElectroDB client-side.
 * The integration test `tests/integration/rollback/std-classify.test.ts`
 * proves this property end-to-end.
 *
 * **Memory floor (RESEARCH OQ5 disposition):** The `v1Index` Map holds the
 * entire v1 record set in memory between Phase 1 and Phase 3. Memory
 * bound ≈ `v1_record_count × record_size`. For a 1M-record table at 2KB/record
 * this is ~2GB. Accepted as the v0.1 operational floor; deferred to v0.2 for
 * streaming-interleaved scans.
 *
 * Reference: RESEARCH §Section 3 lines 1086-1163, §Pattern 2 lines 314-352.
 */

import type { AnyElectroEntity, Migration } from '../migrations/types.js';
import { CONSISTENT_READ } from '../safety/index.js';
import { extractDomainKey } from './identity-stamp.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single classified record emitted by the `classifyTypeTable` generator.
 *
 * - `type: 'A'`: both v1Original and v2 are populated.
 * - `type: 'B'`: only v2 is populated (v1Original is undefined).
 * - `type: 'C'`: only v1Original is populated (v2 is undefined).
 */
export interface TypeTableEntry {
  type: 'A' | 'B' | 'C';
  /** The v1 record (present for Type A and Type C). */
  v1Original?: Record<string, unknown>;
  /** The v2 record (present for Type A and Type B). */
  v2?: Record<string, unknown>;
  /** Deterministic user-domain key string, e.g. `'id=u-1'`. */
  domainKey: string;
}

/**
 * A count summary for one classifier run — reserved for the snapshot strategy's
 * count pre-pass (Plan 05-06). Define now so Plan 05-06 can import without
 * re-export friction.
 *
 * Reference: RESEARCH §Section 3 line 1126.
 */
export interface TypeTableCounts {
  a: number;
  b: number;
  c: number;
}

/**
 * Arguments for `classifyTypeTable`.
 */
export interface ClassifyTypeTableArgs {
  /** The migration whose `from` and `to` entities drive the two scans. */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /**
   * DynamoDB page size (defaults to 100 — see RESEARCH §Section 3 for
   * the memory × heartbeat tradeoff).
   */
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify all records in the migration's target table into Type A / B / C
 * cells (RBK-04) using a two-scan union strategy.
 *
 * **Algorithm:**
 * 1. Phase 1 — Index v1: scan `migration.from` with CONSISTENT_READ, build
 *    `Map<domainKey, v1Record>`.
 * 2. Phase 2 — Stream v2: scan `migration.to` with CONSISTENT_READ; for each
 *    v2 record, check the Map → emit Type A (found) or Type B (not found).
 *    Track each emitted domainKey in a `seen` Set.
 * 3. Phase 3 — Emit C: iterate v1Index; any key NOT in `seen` is Type C.
 *
 * **Consistency (T-05-03-03):** `consistent: CONSISTENT_READ` is passed to
 * every scan call (the named import, not an inline literal — source-scan
 * invariant enforced by `tests/unit/lock/source-scan.test.ts`).
 *
 * **STD safety (T-05-03-01 / RBK-11):** Both scans go through ElectroDB's
 * `entity.scan` which filters by `__edb_e__` AND `__edb_v__`. Cross-entity
 * contamination is impossible.
 *
 * **Memory (T-05-03-04):** The `v1Index` Map holds `~O(v1-record-count)`
 * records in memory between Phase 1 and Phase 3. Deferred to v0.2 for
 * streaming-interleaved optimization (RESEARCH OQ5 disposition).
 *
 * @yields {@link TypeTableEntry} — one entry per classified record.
 */
export async function* classifyTypeTable(
  args: ClassifyTypeTableArgs,
): AsyncGenerator<TypeTableEntry> {
  const limit = args.pageSize ?? 100;

  // Phase 1: index v1 (migration.from.scan — identity-stamp-filtered).
  const v1Index = new Map<string, Record<string, unknown>>();
  let cursor: string | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB scan.go signature is dynamic (not in d.ts)
  const v1Scan = (args.migration.from as any).scan;
  do {
    const page = await v1Scan.go({ cursor, limit, consistent: CONSISTENT_READ }) as {
      data: Record<string, unknown>[];
      cursor: string | null;
    };
    for (const r of page.data) {
      v1Index.set(extractDomainKey(args.migration.from, r), r);
    }
    cursor = page.cursor;
  } while (cursor !== null);

  // Phase 2: stream v2 → emit Type A or Type B.
  const seen = new Set<string>();
  cursor = null;
  // biome-ignore lint/suspicious/noExplicitAny: same — ElectroDB scan.go signature is dynamic
  const v2Scan = (args.migration.to as any).scan;
  do {
    const page = await v2Scan.go({ cursor, limit, consistent: CONSISTENT_READ }) as {
      data: Record<string, unknown>[];
      cursor: string | null;
    };
    for (const r of page.data) {
      const key = extractDomainKey(args.migration.to, r);
      seen.add(key);
      const v1 = v1Index.get(key);
      if (v1 !== undefined) {
        yield { type: 'A', v1Original: v1, v2: r, domainKey: key };
      } else {
        yield { type: 'B', v2: r, domainKey: key };
      }
    }
    cursor = page.cursor;
  } while (cursor !== null);

  // Phase 3: emit Type C — anything in v1 not seen in v2.
  for (const [key, v1] of v1Index.entries()) {
    if (!seen.has(key)) {
      yield { type: 'C', v1Original: v1, domainKey: key };
    }
  }
}
