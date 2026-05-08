/**
 * Seed helper for Phase 4 runner integration tests.
 *
 * Writes N records into a DynamoDB table using the supplied ElectroDB entity's
 * batch-put chain. Uses 25-record slices to stay within DynamoDB's
 * `BatchWriteItem` limit of 25 items per request.
 *
 * Design notes (per README §3.3 hot-key constraint):
 * - This helper is intentionally NOT count-audited. The runner tests use the
 *   framework's own count-audit on the apply path; the seed helper is a
 *   test-fixture utility, not a production retry path.
 * - Throws on any inner ElectroDB error so test failures are loud and obvious.
 * - Default record factory produces synthetic values (`u-000001`, `User 1`)
 *   that are clearly distinguishable from real data in DDB Local logs.
 */

const BATCH_SIZE = 25;

/**
 * Seed `count` records into the table via the supplied ElectroDB entity.
 *
 * @param entity        - Any ElectroDB entity with a `.put([]).go()` batch-put chain.
 * @param count         - Number of records to seed (must be ≥0).
 * @param recordFactory - Optional: produce each record given its 0-based index.
 *                        Default: `(i) => ({ id: `u-${String(i+1).padStart(6,'0')}`, name: `User ${i+1}` })`.
 * @returns void — throws on failure.
 */
// biome-ignore lint/suspicious/noExplicitAny: ElectroDB entity types carry heavy schema generics; `any` here isolates that complexity to this fixture helper.
export async function seedV1Records(
  entity: { put: (records: any[]) => { go: () => Promise<unknown> } },
  count: number,
  recordFactory?: (i: number) => Record<string, unknown>,
): Promise<void> {
  const factory = recordFactory ?? ((i: number) => ({ id: `u-${String(i + 1).padStart(6, '0')}`, name: `User ${i + 1}` }));

  const records: Record<string, unknown>[] = Array.from({ length: count }, (_, i) => factory(i));

  // Slice into 25-record batches (DDB BatchWriteItem limit).
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const batch = records.slice(offset, offset + BATCH_SIZE);
    await entity.put(batch).go();
  }
}
