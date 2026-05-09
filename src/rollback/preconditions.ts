/**
 * `checkPreconditions` — the pre-execution decision gate for `rollback <id>`.
 *
 * RESEARCH §Section 1 (Lifecycle × Strategy Truth Table, lines 1020-1037):
 *   Case 1 (pre-release): status ∈ {pending, failed} OR
 *     (status='applied' AND lockState='release' AND releaseIds.has(migId))
 *   Case 2 (post-release, pre-finalize): status='applied' AND NOT Case 1
 *   Case 3 (post-finalize): status='finalized'
 *
 * RESEARCH §Section 6 (Refusal Truth Table, lines 1301-1316):
 *   - EDB_MIGRATION_NOT_FOUND: target id not in _migrations table
 *   - EDB_ALREADY_REVERTED: target.status === 'reverted'
 *   - EDB_NOT_APPLIED: target.status === 'pending'
 *   - EDB_ROLLBACK_OUT_OF_ORDER (RBK-01): newer applied/finalized row for same entity
 *   - EDB_ROLLBACK_NOT_POSSIBLE / NO_DOWN_FUNCTION: projected or fill-only without down()
 *   - EDB_ROLLBACK_NOT_POSSIBLE / NO_RESOLVER: custom without rollbackResolver
 *   - EDB_ROLLBACK_NOT_POSSIBLE / FINALIZED_ONLY_PROJECTED: snapshot or fill-only on Case 3
 *   - EDB_ROLLBACK_NOT_POSSIBLE / READS_DEPENDENCY_APPLIED (CTX-08, Phase 6):
 *     reads-target has a later-applied migration; roll back that one first
 *
 * RESEARCH §Code Examples, lines 793-889.
 *
 * Call order in Plan 05-09's orchestrator:
 *   const decision = await checkPreconditions({service, migration, strategy});
 *   if (decision.kind === 'refuse') { ... surface error, exit ... }
 *   const { case: lifecycleCase, targetRow } = decision;
 *   // only THEN proceed to acquireLock(...)
 *
 * RBK-01, RBK-09, RBK-10.
 */
import type { AnyElectroEntity, Migration } from '../migrations/types.js';
import type { MigrationsServiceBundle } from '../internal-entities/service.js';
import { EDBRollbackNotPossibleError, EDBRollbackOutOfOrderError } from '../errors/index.js';
import { ROLLBACK_REASON_CODES } from '../errors/codes.js';
import { readLockRow } from '../lock/read-lock-row.js';
import { determineLifecycleCase } from './lifecycle-case.js';
import { findHeadViolation, type MigrationsRow } from './head-only.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Arguments accepted by {@link checkPreconditions}. */
export interface CheckPreconditionsArgs {
  /** The MigrationsServiceBundle (entity stubs in tests, real service in production). */
  service: MigrationsServiceBundle;
  /** The Migration object loaded from the migration file. */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** The rollback strategy requested by the operator via `--strategy`. */
  strategy: 'projected' | 'snapshot' | 'fill-only' | 'custom';
}

/**
 * Discriminated union returned by `checkPreconditions`.
 *
 * @variant `{ kind: 'proceed'; case: 'case-1'; targetRow }` — pre-release path.
 *   The orchestrator runs the Case 1 flow (scan v2 and DELETE all v2 records).
 *
 * @variant `{ kind: 'proceed'; case: 'case-2' | 'case-3'; targetRow }` — post-release
 *   or post-finalize path. The orchestrator runs the type-table classifier.
 *
 * @variant `{ kind: 'refuse'; error }` — one of the refusal conditions triggered.
 *   The CLI surfaces `error.message` at log level `error` and exits non-zero
 *   (except for `EDB_ALREADY_REVERTED` / `EDB_NOT_APPLIED`, which are friendly
 *   no-ops at exit code 0 per RESEARCH §Section 6).
 */
export type RollbackDecision =
  | { kind: 'proceed'; case: 'case-1'; targetRow: MigrationsRow }
  | { kind: 'proceed'; case: 'case-2' | 'case-3'; targetRow: MigrationsRow }
  | { kind: 'refuse'; error: EDBRollbackOutOfOrderError | EDBRollbackNotPossibleError | Error };

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Pre-execution decision gate: reads `_migrations` rows + lock row and applies
 * the RBK-01/09/10 truth tables without acquiring any lock.
 *
 * Step sequence (RESEARCH §Code Examples lines 802-878 + PATTERNS lines 156-176):
 *  1. Scan all `_migrations` rows.
 *  2. Find target by migration.id — refuse EDB_MIGRATION_NOT_FOUND if absent.
 *  3. If target.status==='reverted' — refuse EDB_ALREADY_REVERTED.
 *  4. If target.status==='pending' — refuse EDB_NOT_APPLIED.
 *  5. Head-only check (RBK-01) via findHeadViolation — refuse EDB_ROLLBACK_OUT_OF_ORDER.
 *  6. Read lock row (needed for Case 1 success-path detection).
 *  7. Determine lifecycle case via determineLifecycleCase.
 *  8. Strategy refusal table (Case 3 × snapshot/fill-only → FINALIZED_ONLY_PROJECTED).
 *  9. Capability checks (projected/fill-only → needs down(); custom → needs rollbackResolver).
 * 10. CTX-08 cross-entity reads check (Phase 6) — refuse if any migration on a
 *     `reads`-target entity has been applied since M. Uses fromVersion numeric
 *     comparison (clock-skew safe per RESEARCH §A3).
 * 11. Return { kind: 'proceed', case: lifecycleCase, targetRow }.
 */
export async function checkPreconditions(args: CheckPreconditionsArgs): Promise<RollbackDecision> {
  // Step 1: scan all _migrations rows (small cardinality — one row per ever-applied migration).
  // The `as unknown as { data: MigrationsRow[] }` cast is needed because ElectroDB's TS inference
  // types `set`-attribute fields as `string[]`, whereas at runtime they are `Set<string>`.
  // `findBlockingReadsDependency` normalises this defensively via `Array.isArray`.
  const scanResult = (await args.service.migrations.scan.go({ pages: 'all' })) as unknown as { data: MigrationsRow[] };
  const allRows = scanResult.data;

  // Step 2: find target row.
  const targetRow = allRows.find((r) => r.id === args.migration.id);
  if (!targetRow) {
    return { kind: 'refuse', error: buildNotFoundError(args.migration.id) };
  }

  // Step 3: already reverted — friendly no-op.
  if (targetRow.status === 'reverted') {
    return { kind: 'refuse', error: buildAlreadyRevertedError(args.migration.id) };
  }

  // Step 4: pending — never applied, nothing to roll back.
  if (targetRow.status === 'pending') {
    return { kind: 'refuse', error: buildNotAppliedError(args.migration.id) };
  }

  // Step 5: head-only check (RBK-01).
  const headViolation = findHeadViolation(allRows, targetRow);
  if (headViolation) {
    const err = new EDBRollbackOutOfOrderError(
      `Cannot rollback ${args.migration.id} — newer applied migration ${headViolation.id} exists for entity ${targetRow.entityName}.`,
      { offending: headViolation.id, entity: targetRow.entityName, target: args.migration.id },
    );
    (err as Error & { remediation?: string }).remediation =
      `Run \`rollback ${headViolation.id}\` first, then re-run \`rollback ${args.migration.id}\`.`;
    return { kind: 'refuse', error: err };
  }

  // Step 6: read lock row (for Case 1 success-path detection).
  const lockRow = await readLockRow(args.service);

  // Step 7: determine lifecycle case.
  const lifecycleCase = determineLifecycleCase(targetRow, lockRow, args.migration.id);

  // Case 1 (pre-release): strategy is recorded but the action is identical regardless —
  // scan v2 and DELETE all v2 records. `down` is NOT required. Short-circuit here so
  // the strategy/capability checks below do not fire for Case 1.
  // RESEARCH §Section 1 lines 1031: "strategy is recorded but the action is identical for Case 1"
  if (lifecycleCase === 'case-1') {
    return { kind: 'proceed', case: 'case-1', targetRow };
  }

  // Step 8: strategy refusal table — Case 3 forbids snapshot + fill-only.
  if (lifecycleCase === 'case-3') {
    if (args.strategy === 'snapshot' || args.strategy === 'fill-only') {
      const err = new EDBRollbackNotPossibleError(
        `Strategy '${args.strategy}' is not permitted on a finalized migration. Use 'projected' or 'custom'.`,
        { reason: ROLLBACK_REASON_CODES.FINALIZED_ONLY_PROJECTED, strategy: args.strategy, migrationId: args.migration.id },
      );
      (err as Error & { remediation?: string }).remediation =
        `Use --strategy projected (requires down()) or --strategy custom (requires rollbackResolver).`;
      return { kind: 'refuse', error: err };
    }
  }

  // Step 9: capability checks (applies to Case 2 and Case 3).
  if ((args.strategy === 'projected' || args.strategy === 'fill-only') && !args.migration.down) {
    const err = new EDBRollbackNotPossibleError(
      `Strategy '${args.strategy}' requires migration.down to be defined.`,
      { reason: ROLLBACK_REASON_CODES.NO_DOWN_FUNCTION, strategy: args.strategy, migrationId: args.migration.id },
    );
    (err as Error & { remediation?: string }).remediation =
      `Either define down() in your migration.ts and re-run, or use --strategy snapshot (Case 2 only) or --strategy custom (with rollbackResolver).`;
    return { kind: 'refuse', error: err };
  }

  if (args.strategy === 'custom' && !args.migration.rollbackResolver) {
    const err = new EDBRollbackNotPossibleError(
      `Strategy 'custom' requires migration.rollbackResolver to be defined.`,
      { reason: ROLLBACK_REASON_CODES.NO_RESOLVER, strategy: 'custom', migrationId: args.migration.id },
    );
    (err as Error & { remediation?: string }).remediation =
      `Define rollbackResolver in your migration.ts and re-run.`;
    return { kind: 'refuse', error: err };
  }

  // Step 10: CTX-08 — refuse if any migration on a `reads`-target entity has been applied since M.
  //
  // Rationale (RESEARCH §OQ7, README §6.6.2):
  //   When migration M reads entity Y via ctx.entity(Y), the on-disk shape of Y
  //   must match the source Y the migration imported. That holds iff no applied/finalized
  //   migration on Y has fromVersion >= M's toVersion. If Y has any such migration,
  //   on-disk Y is at a newer shape — rolling back M would re-introduce v1 records of
  //   M's entity that reference a now-stale Y shape.
  //
  //   The head-only rule (Step 5) catches within-entity ordering. CTX-08 extends
  //   the rule across entities: a Team migration sequenced after the User migration M,
  //   where M declares reads:[Team], blocks M's rollback. The user must roll back the
  //   Team migration first.
  //
  // Sequence comparison uses `fromVersion` (numeric string) per RESEARCH §A3 /
  // Pitfall 6 — `appliedAt` ISO timestamps are clock-skew-vulnerable in multi-developer
  // environments. `fromVersion` is sequence-monotonic per entity.
  //
  // Note: Case 1 short-circuits at Step 7 (line ~133) — Step 10 is naturally
  // unreachable for Case 1 (pre-release rollback has no reads-dependency semantic).
  //
  // Guard: skip the lookup when reads is obviously absent. Do NOT rely on
  // `targetRow.reads.size > 0` because ElectroDB / the AWS SDK can return
  // DynamoDB `set` attributes as a plain Array (or a { wrapperName:'Set',
  // values:[] } wrapper) rather than a JS Set — `.size` would then be
  // `undefined` and the check would silently pass. Delegate all normalisation
  // to `findBlockingReadsDependency` which handles all three shapes.
  if (targetRow.reads !== undefined) {
    const blocking = findBlockingReadsDependency(allRows, targetRow);
    if (blocking !== undefined) {
      const err = new EDBRollbackNotPossibleError(
        `Cannot rollback ${args.migration.id}: migration ${blocking.id} on reads-target ` +
          `entity '${blocking.entityName}' has been applied since ${args.migration.id}. ` +
          `Roll back ${blocking.id} first.`,
        {
          reason: ROLLBACK_REASON_CODES.READS_DEPENDENCY_APPLIED,
          blockingMigration: blocking.id,
          readsDependency: blocking.entityName,
          migrationId: args.migration.id,
        },
      );
      (err as Error & { remediation?: string }).remediation =
        `Run \`rollback ${blocking.id}\` first, then re-run \`rollback ${args.migration.id}\`.`;
      return { kind: 'refuse', error: err };
    }
  }

  // Step 11 (was Step 10 in Phase 5): proceed (case-2 or case-3).
  return { kind: 'proceed', case: lifecycleCase, targetRow };
}

// ---------------------------------------------------------------------------
// Refusal error builder helpers
// ---------------------------------------------------------------------------

/**
 * Builds a plain `Error` with code `EDB_MIGRATION_NOT_FOUND`.
 * Uses a plain Error (not an EDB* class) per RESEARCH §Section 6 — there is no
 * EDBMigrationNotFoundError class; the code is surfaced via duck-typed `.code`.
 */
function buildNotFoundError(migrationId: string): Error & { code: string; remediation: string } {
  const err = new Error(`Migration ${migrationId} not found in audit log.`) as Error & { code: string; remediation: string };
  err.code = 'EDB_MIGRATION_NOT_FOUND';
  err.remediation = `Run \`history\` to list known migrations.`;
  return err;
}

/**
 * Builds a plain `Error` with code `EDB_ALREADY_REVERTED` (friendly no-op).
 */
function buildAlreadyRevertedError(migrationId: string): Error & { code: string; remediation: string } {
  const err = new Error(`Migration ${migrationId} is already reverted.`) as Error & { code: string; remediation: string };
  err.code = 'EDB_ALREADY_REVERTED';
  err.remediation = `Inspect with \`history\`. To roll back the reversion, write a NEW forward migration that re-introduces the change.`;
  return err;
}

/**
 * Builds a plain `Error` with code `EDB_NOT_APPLIED` (friendly no-op).
 */
function buildNotAppliedError(migrationId: string): Error & { code: string; remediation: string } {
  const err = new Error(`Migration ${migrationId} is pending — nothing to roll back.`) as Error & { code: string; remediation: string };
  err.code = 'EDB_NOT_APPLIED';
  err.remediation = `Run \`apply --migration ${migrationId}\` first if you want to apply it.`;
  return err;
}

// ---------------------------------------------------------------------------
// CTX-08 helper
// ---------------------------------------------------------------------------

/**
 * CTX-08 helper — finds a `_migrations` row that blocks rollback of `targetRow`
 * due to a cross-entity reads dependency.
 *
 * A row R is blocking IFF ALL of the following hold:
 *   1. R.entityName ∈ targetRow.reads (the row migrates a reads-target entity)
 *   2. R.status ∈ {'applied', 'finalized'} (active dependency — NOT reverted/pending)
 *   3. parseInt(R.fromVersion) >= parseInt(targetRow.toVersion) (R moves the
 *      reads-target entity from a version >= the version M was authored against)
 *
 * The `>=` semantics: `targetRow.toVersion` is the version that M migrated TO
 * for its OWN entity. A reads-target migration with `fromVersion` equal to or
 * greater than that means the reads-target entity is now at a shape AT LEAST
 * one version newer than what M's source code expected. Rolling back M would
 * re-introduce v1 records that reference a stale reads-target shape.
 *
 * Returns the FIRST blocking row found, sorted by fromVersion ascending so the
 * EARLIEST blocker is reported — the user fixes it first then re-runs.
 * Returns `undefined` if no blocking row exists.
 *
 * RESEARCH §A3 (Pitfall 6): fromVersion comparison is clock-skew safe (vs
 * `appliedAt` ISO timestamps which can drift between machines). Do NOT
 * substitute `appliedAt` for `fromVersion` here.
 *
 * Normalisation note: ElectroDB's TS type infers `set`-attribute fields as
 * `string[]`, but at runtime they are `Set<string>`. This function normalises
 * `targetRow.reads` defensively via `Array.isArray` so that both representations
 * are handled correctly.
 */
function findBlockingReadsDependency(
  allRows: MigrationsRow[],
  targetRow: MigrationsRow,
): MigrationsRow | undefined {
  const readsSet: Set<string> =
    targetRow.reads === undefined
      ? new Set()
      : Array.isArray(targetRow.reads)
        ? new Set(targetRow.reads as unknown as string[])
        : targetRow.reads;

  if (readsSet.size === 0) return undefined;

  const targetToVersionInt = Number.parseInt(targetRow.toVersion, 10);

  const blockers = allRows
    .filter((r) => {
      // Must be a reads-target entity.
      if (!readsSet.has(r.entityName)) return false;
      // Must be an active applied/finalized dependency (not reverted or pending).
      if (r.status !== 'applied' && r.status !== 'finalized') return false;
      // fromVersion numeric comparison — clock-skew-safe per RESEARCH §A3 / Pitfall 6.
      const rFromInt = Number.parseInt(r.fromVersion ?? '', 10);
      // NaN check: malformed fromVersion → treat as non-blocking (defensive).
      if (Number.isNaN(rFromInt) || Number.isNaN(targetToVersionInt)) return false;
      // Blocking iff reads-target was migrated from a version >= M's toVersion.
      return rFromInt >= targetToVersionInt;
    })
    // Sort ascending by fromVersion so the earliest blocker is reported first.
    .sort((a, b) => Number.parseInt(a.fromVersion ?? '0', 10) - Number.parseInt(b.fromVersion ?? '0', 10));

  return blockers[0];
}
