/**
 * `projected` rollback strategy executor — the default strategy (RBK-05).
 *
 * Per-type dispatch table (RESEARCH §Section 4 lines 1180-1186):
 * | Type | Action                                    | Audit increment          |
 * |------|-------------------------------------------|--------------------------|
 * | A    | v1Derived = await down(v2) → put as v1    | addReverted(1) after flush |
 * | B    | v1Derived = await down(v2) → put as v1    | addReverted(1) after flush |
 * | C    | v1Deletes.push(entry.v1Original!) (delete v1 mirror — honors app-side delete) | addDeleted(1) after flush |
 *
 * **down-throw bubble pattern (RESEARCH §Pattern 5):** If `down(v2)` throws,
 * `audit.incrementFailed()` is called and the error re-throws. This mirrors
 * the apply-flow up-throw bubble at `src/runner/apply-flow.ts:142-147`.
 * The orchestrator (Plan 05-09) catches the rethrown error, calls `markFailed`,
 * and transitions the lock accordingly.
 *
 * **OQ-2 disposition mirror:** If `down(v2)` returns `null` or `undefined`,
 * the record is counted as `skipped` — no v1 is written. This mirrors the
 * apply-flow `up()` returning null behavior (Phase 4 cross-reference).
 *
 * **Memory note (T-05-05-04):** Puts and v1Deletes are buffered for the entire
 * classifier output before `batchFlushRollback`. For large tables this is
 * bounded by the type-table memory floor (RESEARCH OQ5 — accepted in Plan 05-03).
 */

import { batchFlushRollback } from '../batch-flush-rollback.js';
import type { TypeTableEntry } from '../type-table.js';
import type { RollbackAudit } from '../audit.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Migration, AnyElectroEntity } from '../../migrations/index.js';
import type { MigrationCtx } from '../../ctx/types.js';

// ---------------------------------------------------------------------------
// Shared strategy argument shape
// ---------------------------------------------------------------------------

export interface ExecuteStrategyArgs {
  /** The type-table classifier async generator (from Plan 05-03). */
  classify: AsyncGenerator<TypeTableEntry>;
  /** The migration whose `from`/`to` entities and `down()` function are used. */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** DynamoDB document client used for the batch flush. */
  client: DynamoDBDocumentClient;
  /** DynamoDB table name. */
  tableName: string;
  /** Rollback audit accumulator (from Plan 05-04). */
  audit: RollbackAudit;
  /**
   * Phase 6 / CTX-01 — the cross-entity reads ctx. Forwarded to `migration.down(record, ctx)`
   * so user `down()` functions can call `ctx.entity(Other).get(...)`. Built by the
   * orchestrator via `buildCtx(...)` and threaded through.
   *
   * **Pitfall 4 (RESEARCH lines 569-573):** Phase 5 omitted this field; user
   * `down()` functions that called `ctx.entity(...)` in the rollback path crashed
   * with "Cannot read properties of undefined (reading 'entity')". Phase 6 fixes
   * this by passing the orchestrator-built ctx.
   */
  ctx: MigrationCtx;
}

// ---------------------------------------------------------------------------
// Strategy executor
// ---------------------------------------------------------------------------

/**
 * Execute the `projected` rollback strategy for the given type-table classifier
 * output (RBK-05 — default strategy).
 *
 * Preconditions (enforced by Plan 05-02 before dispatch reaches here):
 *   - `migration.down` is defined (non-null).
 *
 * @param args - Strategy arguments including classifier, migration, client, tableName, audit.
 */
export async function executeProjected(args: ExecuteStrategyArgs): Promise<void> {
  const puts: Record<string, unknown>[] = [];
  const v1Deletes: Record<string, unknown>[] = [];

  for await (const entry of args.classify) {
    args.audit.incrementScanned();

    if (entry.type === 'A' || entry.type === 'B') {
      // RESEARCH Pattern 5 — down throw bubbles after audit.failed++ (mirrors apply-flow up-throw bubble).
      let v1Derived: unknown;
      try {
        v1Derived = await args.migration.down!(entry.v2!, args.ctx);
      } catch (err) {
        args.audit.incrementFailed();
        throw err; // RUN-08 fail-fast equivalent for rollback
      }

      if (v1Derived === null || v1Derived === undefined) {
        // OQ-2 disposition mirror: down returning null/undefined → skipped (no v1 written).
        // Mirrors apply-flow: src/runner/apply-flow.ts:148-151
        args.audit.incrementSkipped();
        continue;
      }

      puts.push(v1Derived as Record<string, unknown>);
    } else {
      // entry.type === 'C' — delete the v1 mirror (honor app-side deletion).
      // Type D is unreachable per the classifier construction (RESEARCH §Section 3 line 1097).
      v1Deletes.push(entry.v1Original!);
    }
  }

  await batchFlushRollback({
    migration: args.migration,
    client: args.client,
    tableName: args.tableName,
    puts,
    v1Deletes,
  });

  // The entire batch wrote successfully if batchFlushRollback returned without throwing.
  // Account for the batched writes in the audit counters.
  args.audit.addReverted(puts.length);
  args.audit.addDeleted(v1Deletes.length);
}
