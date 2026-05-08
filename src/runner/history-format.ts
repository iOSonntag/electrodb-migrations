/**
 * CLI-04 stable JSON contract for `electrodb-migrations history --json`.
 *
 * Open Question 5 disposition (Plan 04-06): top-level array of `_migrations`
 * rows verbatim; ISO-8601 dates kept as-is; `reads` Set converted to a
 * sorted string array. Suitable for `jq '.[] | select(.status == "failed")'`.
 */

/**
 * Subset of `_migrations` row shape that `history --json` emits. The full
 * row schema lives in `src/internal-entities/migrations.ts`; this type
 * mirrors it but with `reads` as `ReadonlyArray<string>` (post-set→array
 * conversion) so the JSON output contract is stable.
 */
export interface HistoryRow {
  id: string;
  schemaVersion: number;
  kind: 'transform';
  status: 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';
  appliedAt?: string;
  finalizedAt?: string;
  revertedAt?: string;
  appliedBy?: string;
  appliedRunId?: string;
  revertedRunId?: string;
  fromVersion: string;
  toVersion: string;
  entityName: string;
  fingerprint: string;
  itemCounts?: { scanned: number; migrated: number; skipped: number; failed: number };
  error?: { code?: string; message?: string; details?: string };
  reads?: ReadonlyArray<string>;
  rollbackStrategy?: 'projected' | 'snapshot' | 'fill-only' | 'custom';
  hasDown?: boolean;
  hasRollbackResolver?: boolean;
}

/** Raw ElectroDB scan result row — `reads` may arrive as `Set<string>`. */
export interface RawHistoryRow extends Omit<HistoryRow, 'reads'> {
  reads?: ReadonlySet<string> | ReadonlyArray<string>;
}

export interface FormatHistoryJsonOptions {
  /** When set, only rows whose `entityName` equals this value are included. */
  entity?: string;
}

/**
 * Convert an array of `_migrations` rows to the `history --json` output.
 *
 * - Sorted ascending by `id` (timestamp-prefixed ids → chronological order).
 * - `reads` Set values converted to a sorted string array (T-04-06-03 mitigate).
 * - Date fields kept verbatim as ISO-8601 strings (HF-4).
 * - Optional `entity` filter applied before sorting (HF-6).
 *
 * Returns a pretty-printed JSON string with a trailing newline.
 */
export function formatHistoryJson(
  rows: ReadonlyArray<RawHistoryRow>,
  options: FormatHistoryJsonOptions = {},
): string {
  const filtered =
    options.entity !== undefined ? rows.filter((r) => r.entityName === options.entity) : rows;

  const sorted = [...filtered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const normalized: HistoryRow[] = sorted.map((r) => {
    const { reads, ...rest } = r;
    const readsArr = reads === undefined ? undefined : [...reads].sort();
    return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) } as HistoryRow;
  });

  return `${JSON.stringify(normalized, null, 2)}\n`;
}
