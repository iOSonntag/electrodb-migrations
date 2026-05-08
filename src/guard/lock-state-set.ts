/**
 * The set of `_migration_state.lockState` values that cause the guard
 * middleware to throw `EDBMigrationInProgressError` (GRD-04).
 *
 * **Decision A7 (per `.planning/phases/03-internal-entities-lock-guard/03-WAVE0-NOTES.md`):**
 * `'finalize'` is INTENTIONALLY EXCLUDED. README §1 explicitly states maintenance
 * mode (lockState=`'finalize'`) does NOT gate app traffic — the long v1 cleanup
 * runs against the same table without affecting reads/writes from app code.
 * REQUIREMENTS.md GRD-04 lists `'finalize'` in the gating set, but README is the
 * documentation contract per CLAUDE.md DST-01; the contradiction is recorded in
 * WAVE0-NOTES for an explicit retrospective resolution rather than silently
 * re-resolved here.
 *
 * **If you arrived here from REQUIREMENTS.md GRD-04 thinking "should I add
 * finalize?":** read `03-WAVE0-NOTES.md` Decision A7 FIRST. The set has been
 * deliberated.
 *
 * **Members (5):** `apply`, `rollback`, `release`, `failed`, `dying`.
 *
 * Excluded states: `free` (no migration in progress) and `finalize` (per A7).
 */
export const GATING_LOCK_STATES: ReadonlySet<string> = new Set([
  'apply',
  'rollback',
  'release',
  'failed',
  'dying',
  // 'finalize' — see Decision A7 above.
]);
