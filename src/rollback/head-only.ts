/**
 * `findHeadViolation` — RBK-01 head-only rule enforcement.
 *
 * RESEARCH §Code Examples lines 880-888 (verbatim spec):
 *
 *   For the same entity, find any row with a LATER `toVersion` that is
 *   `applied` or `finalized` (not reverted, failed, or pending). If such a
 *   row exists, returning it tells `checkPreconditions` to refuse the rollback
 *   with an `EDBRollbackOutOfOrderError`.
 *
 * Design rationale: a user who rolls back a non-head migration would leave a
 * newer migration's assumption (that v_{n-1} exists as the v2 shape) broken
 * on disk. The head-only rule prevents that data-corruption scenario before
 * any lock is acquired.
 *
 * **Numeric comparison** is mandatory. `toVersion` is stored as a decimal-
 * integer string ('1', '2', … '10'). Lexicographic comparison would treat '9'
 * as later than '10', which is wrong. `Number.parseInt(v, 10)` is the canonical
 * pattern already used in `src/runner/load-pending.ts:150`.
 *
 * RBK-01.
 */

/** Minimal `_migrations` row shape needed for head-only checks. */
export interface MigrationsRow {
  id: string;
  entityName: string;
  status: string;
  toVersion: string;
}

/**
 * Returns the first LATER-sequenced `applied` or `finalized` migration row for
 * the same entity as `target`, or `undefined` if the target IS the head.
 *
 * Pure function — no I/O.
 *
 * @param rows   - All `_migrations` rows (full scan result from `checkPreconditions`).
 * @param target - The migration the operator wants to roll back.
 * @returns The violating row (newer applied/finalized), or `undefined` if target is safe to roll back.
 */
export function findHeadViolation(rows: MigrationsRow[], target: MigrationsRow): MigrationsRow | undefined {
  // For the same entity, find any row with later toVersion that is `applied` or `finalized` (not reverted).
  return rows.find(
    (r) =>
      r.entityName === target.entityName &&
      r.id !== target.id &&
      (r.status === 'applied' || r.status === 'finalized') &&
      Number.parseInt(r.toVersion ?? '0', 10) > Number.parseInt(target.toVersion ?? '0', 10),
  );
}
