/**
 * `fill-only` rollback strategy executor (RBK-07).
 *
 * Per-type dispatch table (RESEARCH §Section 4 lines 1200-1207):
 * | Type | Action                                    | Audit increment          |
 * |------|-------------------------------------------|--------------------------|
 * | A    | KEEP — no DDB write                       | incrementSkipped()       |
 * | B    | v1Derived = await down(v2) → put as v1    | addReverted(1) after flush |
 * | C    | KEEP — no DDB write                       | incrementSkipped()       |
 *
 * The `fill-only` strategy is the lossless complement of `projected`:
 * it only FILLS IN records that exist in v2 but NOT in v1 (type B). It
 * deliberately does NOT remove type C (app-side-deleted v1 mirrors) and
 * does NOT re-derive type A (v1 already exists — keep it).
 *
 * **down-throw bubble pattern (RESEARCH §Pattern 5):** If `down(v2)` throws
 * on a type B record, `audit.incrementFailed()` is called and the error
 * re-throws. Mirrors apply-flow at `src/runner/apply-flow.ts:142-147`.
 *
 * **OQ-2 disposition mirror:** If `down(v2)` returns `null` or `undefined`,
 * the record is counted as `skipped` — no v1 is written. Same policy as
 * `executeProjected`.
 *
 * **Memory note (T-05-05-04):** Puts are buffered for the entire classifier
 * output before `batchFlushRollback`. Memory bound ≈ `typeB_count × record_size`.
 * Accepted for v0.1 (RESEARCH OQ5 disposition from Plan 05-03).
 */

import { batchFlushRollback } from '../batch-flush-rollback.js';
import type { TypeTableEntry } from '../type-table.js';
import type { RollbackAudit } from '../audit.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Migration, AnyElectroEntity } from '../../migrations/index.js';
import type { ExecuteStrategyArgs } from './projected.js';

// Re-export the shared strategy args type from the projected module so
// callers can import it from either strategy file.
export type { ExecuteStrategyArgs };

// ---------------------------------------------------------------------------
// Strategy executor
// ---------------------------------------------------------------------------

/**
 * Execute the `fill-only` rollback strategy for the given type-table classifier
 * output (RBK-07).
 *
 * Preconditions (enforced by Plan 05-02 before dispatch reaches here):
 *   - `migration.down` is defined (non-null).
 *
 * @param args - Strategy arguments including classifier, migration, client, tableName, audit.
 */
export async function executeFillOnly(args: ExecuteStrategyArgs): Promise<void> {
  const puts: Record<string, unknown>[] = [];

  for await (const entry of args.classify) {
    args.audit.incrementScanned();

    if (entry.type === 'B') {
      // Type B: record exists in v2 but NOT in v1 — fill it in by running down().
      let v1Derived: unknown;
      try {
        v1Derived = await args.migration.down!(entry.v2!, args.ctx);
      } catch (err) {
        // down-throw bubble: RESEARCH Pattern 5 + apply-flow src/runner/apply-flow.ts:142-147
        args.audit.incrementFailed();
        throw err; // RUN-08 fail-fast equivalent for rollback
      }

      if (v1Derived === null || v1Derived === undefined) {
        // OQ-2 mirror: down returning null/undefined → skip (no v1 written).
        args.audit.incrementSkipped();
        continue;
      }

      puts.push(v1Derived as Record<string, unknown>);
    } else {
      // Type A: keep v1 as-is (already correct — no write needed).
      // Type C: keep v1 as-is (honor app-side retention — no delete).
      // Type D: unreachable by classifier construction (RESEARCH §Section 3 line 1097).
      args.audit.incrementSkipped();
    }
  }

  // Only call batchFlushRollback if there are puts to send.
  if (puts.length > 0) {
    await batchFlushRollback({
      migration: args.migration,
      client: args.client,
      tableName: args.tableName,
      puts,
    });
  }

  // Account for the batched puts in the audit counters.
  args.audit.addReverted(puts.length);
}
