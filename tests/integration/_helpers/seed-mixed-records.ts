/**
 * Mixed-record seed helper for Phase 5 type-table classifier integration tests.
 *
 * Produces A/B/C cell populations so rollback integration tests can target a
 * specific lifecycle case without running the full apply path:
 *
 * - Type A: BOTH v1 and v2 records present (id was migrated via `up()` — v1 is
 *   the pre-apply original; v2 is the post-apply write). Used to verify that the
 *   classifier correctly identifies co-located records as "type A".
 *
 * - Type B: v2-ONLY record (the item was written fresh on v2, never had a v1).
 *   Used to verify the classifier identifies orphan v2 records as "type B".
 *
 * - Type C: v1-ONLY record (the item was migrated but then the v2 was deleted by
 *   the application, leaving the v1 "mirror" behind). Used to verify the classifier
 *   identifies orphan v1 records as "type C".
 *
 * Returns the three id arrays so tests can later assert which records survived
 * each rollback strategy (projected / fill-only / custom) per-cell.
 *
 * Uses 25-record slice batches when any count exceeds 25 (DDB BatchWriteItem limit).
 *
 * References:
 * - RBK-04: type-table classification (A/B/C)
 * - VALIDATION invariant 6 (STD safety — only User records affected)
 * - VALIDATION invariant 11 (Case 1 lossless)
 * - Plan 05-01 (Phase 5 Wave 0 seed infrastructure)
 */

const BATCH_SIZE = 25;

/**
 * Arguments for `seedMixedRecords`.
 */
export interface SeedMixedRecordsArgs {
  /**
   * v1 entity (e.g., `createUserV1(doc, tableName)`).
   * Type A and Type C records are written through this entity.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity types carry heavy schema generics.
  v1Entity: { put: (records: any[]) => { go: () => Promise<unknown> } };
  /**
   * v2 entity (e.g., `createUserV2(doc, tableName)`).
   * Type A and Type B records are written through this entity.
   */
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity types carry heavy schema generics.
  v2Entity: { put: (records: any[]) => { go: () => Promise<unknown> } };
  /** Number of Type A records to seed (v1 + v2 both present). */
  aCount: number;
  /** Number of Type B records to seed (v2-only, fresh). */
  bCount: number;
  /** Number of Type C records to seed (v1-only, v2 deleted). */
  cCount: number;
}

/**
 * Result of `seedMixedRecords` — the three id arrays for per-cell assertions.
 */
export interface SeedMixedRecordsResult {
  /** IDs of Type A records (both v1 and v2 present). */
  aIds: string[];
  /** IDs of Type B records (v2-only). */
  bIds: string[];
  /** IDs of Type C records (v1-only). */
  cIds: string[];
}

/**
 * Helper to write a batch of records in 25-item slices.
 */
async function putBatch(
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity types carry heavy schema generics.
  entity: { put: (records: any[]) => { go: () => Promise<unknown> } },
  records: Record<string, unknown>[],
): Promise<void> {
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    await entity.put(records.slice(offset, offset + BATCH_SIZE)).go();
  }
}

/**
 * Seed a mixed A/B/C cell population into the table.
 *
 * Type A records have distinct ID prefix `a-`, Type B use `b-`, Type C use `c-`
 * so test assertions can identify cells without relying on scan ordering.
 *
 * @param args - See {@link SeedMixedRecordsArgs}.
 * @returns Three id arrays (aIds, bIds, cIds) for per-cell post-condition assertions.
 */
export async function seedMixedRecords(args: SeedMixedRecordsArgs): Promise<SeedMixedRecordsResult> {
  const { v1Entity, v2Entity, aCount, bCount, cCount } = args;

  // Build id sets with namespaced prefixes.
  const aIds = Array.from({ length: aCount }, (_, i) => `a-${String(i + 1).padStart(6, '0')}`);
  const bIds = Array.from({ length: bCount }, (_, i) => `b-${String(i + 1).padStart(6, '0')}`);
  const cIds = Array.from({ length: cCount }, (_, i) => `c-${String(i + 1).padStart(6, '0')}`);

  // Type A: write BOTH v1 and v2 records (co-located, same id).
  // v1 record: {id, name}
  const aV1Records = aIds.map((id) => ({ id, name: `Type-A User ${id}` }));
  // v2 record: {id, name, status='active'} — written through v2 entity
  const aV2Records = aIds.map((id) => ({ id, name: `Type-A User ${id}`, status: 'active' as const }));

  await putBatch(v1Entity, aV1Records);
  await putBatch(v2Entity, aV2Records);

  // Type B: write ONLY v2 records (fresh v2, never had a v1).
  const bV2Records = bIds.map((id) => ({ id, name: `Type-B User ${id}`, status: 'active' as const }));
  await putBatch(v2Entity, bV2Records);

  // Type C: write ONLY v1 records (v2 was deleted; v1 mirror left behind).
  const cV1Records = cIds.map((id) => ({ id, name: `Type-C User ${id}` }));
  await putBatch(v1Entity, cV1Records);

  return { aIds, bIds, cIds };
}
