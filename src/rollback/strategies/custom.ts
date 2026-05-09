/**
 * RBK-08: Custom rollback strategy executor.
 *
 * Dispatches each {@link TypeTableEntry} from the type-table classifier to the
 * user-supplied `migration.rollbackResolver`, schema-validates every non-null
 * return value via Pitfall 3 mitigation ({@link validateResolverResult}), and
 * routes the validated result to the correct put/delete/skip path.
 *
 * **Per-type action table (RESEARCH §Section 4 lines 1208-1219):**
 *
 * | Type | resolver result | Action                                             | Audit  |
 * |------|-----------------|----------------------------------------------------|--------|
 * | A    | null/undefined  | `v1Deletes.push(v1Original)` — delete v1 mirror    | deleted++ |
 * | A    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++ |
 * | B    | null/undefined  | no-op (v1 doesn't exist for B; "skip B null")      | skipped++ |
 * | B    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++ |
 * | C    | null/undefined  | `v1Deletes.push(v1Original)` — delete v1 mirror    | deleted++ |
 * | C    | v1-shaped obj   | validate → `puts.push(v1)`                         | reverted++ |
 *
 * **Pitfall 3 (T-05-07-01):** Every non-null resolver result passes through
 * `validateResolverResult` before entering the put batch. A v2-shaped record
 * returned by the resolver would silently corrupt v1 rows; the validator calls
 * `(v1Entity as any).put(result).params()` — ElectroDB's schema validation
 * throws on wrong types / missing required fields. The error is wrapped with
 * `domainKey` context and rethrown; this function's `try/catch` increments
 * `audit.failed` and rethrows for the orchestrator's fail-fast path.
 *
 * **undefined === null normalization:** Returning `undefined` is treated
 * as `null` (additive widening for resolver authors who forget the explicit
 * `null` return). The unit tests pin this invariant.
 *
 * **Defensive resolver guard:** The `!resolver` check is defensive — callers
 * are Plan 05-02 preconditions that refuse the `custom` path when
 * `!migration.rollbackResolver`. If somehow reached, an explicit error is
 * thrown rather than a silent no-op.
 *
 * @see validateResolverResult - Pitfall 3 mitigation (Plan 05-04).
 * @see batchFlushRollback     - Heterogeneous Put+Delete flush (Plan 05-04).
 * @see RBK-08                 - Requirement for custom resolver dispatch.
 * @see RESEARCH §Section 4 lines 1208-1219 — per-type action table.
 * @see RESEARCH Pitfall 3 lines 610-637 — resolver-validate semantics.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { batchFlushRollback } from '../batch-flush-rollback.js';
import { validateResolverResult } from '../resolver-validate.js';
import type { RollbackAudit } from '../audit.js';
import type { TypeTableEntry } from '../type-table.js';
import type { AnyElectroEntity, Migration, RollbackResolverArgs } from '../../migrations/index.js';
import type { MigrationCtx } from '../../ctx/types.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by {@link executeCustom}.
 */
export interface ExecuteCustomArgs {
  /** Async generator of classifier records from `classifyTypeTable`. */
  classify: AsyncGenerator<TypeTableEntry>;
  /** Migration being rolled back. Must have a `rollbackResolver` (defensive check inside). */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** DynamoDB DocumentClient for the batch flush. */
  client: DynamoDBDocumentClient;
  /** Target DynamoDB table name. */
  tableName: string;
  /** Rollback audit accumulator (mutated in place). */
  audit: RollbackAudit;
  /**
   * Phase 6 / CTX-01 — the cross-entity reads ctx. Bound into a one-arg `down` closure
   * passed to `migration.rollbackResolver` so the resolver can call `down(v2)` with one
   * argument while the underlying `migration.down(record, ctx)` always receives ctx.
   *
   * **Pitfall 4 (RESEARCH lines 569-573):** Phase 5 omitted this field; user
   * `down()` functions that called `ctx.entity(...)` in the rollback path crashed.
   * Phase 6 fixes this by binding ctx at the call site in `executeCustom` so the
   * resolver's one-arg `down` contract is preserved.
   */
  ctx: MigrationCtx;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the resolver args for the given classifier entry and migration.
 *
 * Only the fields that are PRESENT for the entry's type are included — the
 * resolver inspects `kind` to know which fields are available:
 *
 *   - Type A: `kind`, `v1Original`, `v2`, `down` (if migration.down is defined)
 *   - Type B: `kind`, `v2`, `down` (if defined) — `v1Original` is absent
 *   - Type C: `kind`, `v1Original`, `down` (if defined) — `v2` is absent
 *
 * RESEARCH §Section 4 line 1216 confirms the args list is intentionally minimal:
 * the resolver has no client reference and cannot escape into unguarded DDB writes.
 */
function buildResolverArgs(
  entry: TypeTableEntry,
  down: Migration<AnyElectroEntity, AnyElectroEntity>['down'],
): RollbackResolverArgs {
  const args: RollbackResolverArgs = { kind: entry.type };
  if (entry.v1Original !== undefined) {
    args.v1Original = entry.v1Original;
  }
  if (entry.v2 !== undefined) {
    args.v2 = entry.v2;
  }
  if (down !== undefined) {
    args.down = down;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Strategy executor
// ---------------------------------------------------------------------------

/**
 * Execute the `custom` rollback strategy for a single migration.
 *
 * Per-record flow:
 *   1. `audit.incrementScanned()`
 *   2. Call `resolver(buildResolverArgs(entry, migration.down))`
 *   3. On resolver throw → `audit.incrementFailed()` + rethrow.
 *   4. Normalize `undefined → null`.
 *   5. Call `validateResolverResult(migration.from, result, entry.domainKey)`.
 *   6. On validate throw → `audit.incrementFailed()` + rethrow.
 *   7. Dispatch:
 *      - `put`    → `puts.push(v1)`
 *      - `delete` + type B → `audit.incrementSkipped()` (v1 doesn't exist for B)
 *      - `delete` + type A/C → `v1Deletes.push(entry.v1Original!)`
 *   8. After loop: `batchFlushRollback(...)` → `audit.addReverted(puts.length)` + `audit.addDeleted(v1Deletes.length)`.
 *
 * @throws If resolver throws or `validateResolverResult` throws — the first
 *         failing record aborts the loop (fail-fast, RUN-08 equivalent for rollback).
 */
export async function executeCustom(args: ExecuteCustomArgs): Promise<void> {
  const { classify, migration, client, tableName, audit } = args;

  const resolver = migration.rollbackResolver;
  if (!resolver) {
    // Defensive — preconditions (Plan 05-02) should have refused this path.
    throw new Error('executeCustom called without rollbackResolver — preconditions bug (RBK-08)');
  }

  const puts: Record<string, unknown>[] = [];
  const v1Deletes: Record<string, unknown>[] = [];

  // Phase 6 / CTX-01 — bind ctx into a one-arg `down` so the resolver can call
  // `down(v2)` per the README §2.2.4 documented contract without needing to
  // know ctx exists. The bound version closes over args.ctx so the underlying
  // `migration.down(record, ctx)` always sees the orchestrator-built ctx.
  //
  // **Pitfall 4 (RESEARCH §A6):** Do NOT pass migration.down directly — that
  // would omit ctx and break user down() functions that call ctx.entity(...).
  // **Pitfall (plan note):** If migration.down is undefined, boundDown must be
  // undefined too — do not replace with a function that throws.
  const boundDown = migration.down !== undefined
    ? (record: unknown, _ctx?: unknown) => migration.down!(record, args.ctx)
    : undefined;

  for await (const entry of classify) {
    audit.incrementScanned();

    // Step 1: Build resolver args (only fields present for this entry's type).
    const resolverArgs = buildResolverArgs(entry, boundDown);

    // Step 2: Invoke the user-supplied resolver.
    let resolverResult: unknown;
    try {
      resolverResult = await resolver(resolverArgs);
    } catch (err) {
      audit.incrementFailed();
      throw err; // Fail-fast: abort the loop.
    }

    // Step 3: Normalize undefined → null (additive widening).
    const normalized = resolverResult === undefined ? null : resolverResult;

    // Step 4: Validate the result. validateResolverResult throws on Pitfall 3
    // (T-05-07-01) — wrap in try/catch so we audit.failed++ before rethrow.
    let validated: { kind: 'put'; v1: Record<string, unknown> } | { kind: 'delete' };
    try {
      validated = await validateResolverResult(migration.from, normalized, entry.domainKey);
    } catch (err) {
      audit.incrementFailed();
      throw err; // Fail-fast: domainKey context is in the error message.
    }

    // Step 5: Dispatch on validated result.
    if (validated.kind === 'put') {
      puts.push(validated.v1);
    } else {
      // validated.kind === 'delete'
      if (entry.type === 'B') {
        // Type B: v1 doesn't exist, "delete null" is a no-op. Count as skipped.
        // RESEARCH §Section 4 line 1218: "v1 doesn't exist for B; document this corner".
        audit.incrementSkipped();
      } else {
        // Type A or C: delete the v1 mirror record.
        v1Deletes.push(entry.v1Original!);
      }
    }
  }

  // Step 6: Flush all accumulated puts and v1Deletes to DynamoDB.
  await batchFlushRollback({
    migration,
    client,
    tableName,
    puts,
    v1Deletes,
  });

  // Step 7: Update audit with batch results.
  audit.addReverted(puts.length);
  audit.addDeleted(v1Deletes.length);
}
