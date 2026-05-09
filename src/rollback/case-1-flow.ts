/**
 * Case 1 (pre-release) rollback flow — RBK-03.
 *
 * **Lifecycle-case detection** (Plan 05-02): The orchestrator (Plan 05-09)
 * calls `determineLifecycleCase` and dispatches:
 *   - `lifecycleCase === 'case-1'` → this module (`rollbackCase1`)
 *   - otherwise → strategy dispatch (Plans 05-05/06/07)
 *
 * **What is Case 1?** The migration is pre-release: either status='pending' /
 * 'failed' (apply never finished), or status='applied' with lockState='release'
 * and `migrationId` in `releaseIds` (apply succeeded but finalize has not
 * yet committed). In both sub-cases, v1 records are still intact on the table
 * alongside the v2 records written by the partial or completed apply.
 *
 * **Algorithm (RESEARCH §Pattern 4 lines 393–411 + PATTERNS.md lines 418–451):**
 *
 *   1. Cursor-based v2 scan via `migration.to.scan.go({cursor, limit, consistent:
 *      CONSISTENT_READ})`. Mirrors the `iterateV1Records` shape from
 *      `src/runner/scan-pipeline.ts:42-63` but targets `migration.to` instead
 *      of `migration.from`. Default page size: 100.
 *
 *   2. For each page: `audit.incrementScanned()` per record, then collect all
 *      records into `v2Deletes`.
 *
 *   3. After each page (if non-empty): call `batchFlushRollback({migration,
 *      client, tableName, v2Deletes})`. The function handles ≤25 slicing
 *      internally. After the call: `audit.addDeleted(result.written)`.
 *
 * **Per-page flush** (PATTERNS.md line 449): bounds memory at one page (default
 * 100 records); each page is a complete `withBatchWriteRetry` cycle.
 *
 * **`migration.down` is NEVER accessed.** Case 1 is the lossless path: v1
 * records are still intact, so there is nothing to reconstruct. Only v2
 * records are deleted. This is the definitive proof that `down` is not
 * required for the pre-release rollback (RBK-03).
 *
 * **Lock fence** (T-05-08-02): The orchestrator (Plan 05-09) acquires
 * `lockState='rollback'` (in GATING_LOCK_STATES) before calling this function.
 * Together with `consistent: CONSISTENT_READ` on every scan page, this
 * provides layered protection against race conditions with in-flight app writes.
 *
 * @see src/runner/scan-pipeline.ts:42-63 — `iterateV1Records` pattern source.
 * @see src/rollback/batch-flush-rollback.ts — heterogeneous batch flush primitive.
 * @see RBK-03 — requirement for lossless pre-release rollback.
 * @see RESEARCH §Pattern 4 — case-1 flow algorithm reference.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import { CONSISTENT_READ } from '../safety/index.js';
import type { RollbackAudit } from './audit.js';
import { batchFlushRollback } from './batch-flush-rollback.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RollbackCase1Args {
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  client: DynamoDBDocumentClient;
  tableName: string;
  audit: RollbackAudit;
  /** Page size for v2 scan. Default: 100 (bounds memory at one page). */
  pageSize?: number;
}

/**
 * Result of a successful Case 1 rollback.
 *
 * Currently empty — the orchestrator reads item counts from the `audit` arg.
 * This interface exists for future extensibility and readability.
 */
export interface RollbackCase1Result {
  // No new fields in v0.1. Orchestrator reads from audit.snapshot().
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Execute a Case 1 (pre-release) rollback by deleting every v2 record.
 *
 * `migration.down` is intentionally NEVER accessed — this is the lossless
 * rollback path (RBK-03): v1 records are intact, so no reconstruction is
 * needed. Only v2 records are deleted.
 *
 * @param args - {@link RollbackCase1Args}
 * @returns {@link RollbackCase1Result} — empty object; caller reads audit counts.
 * @throws Any error thrown by `batchFlushRollback` propagates unswallowed.
 *   The orchestrator is responsible for catching and calling `markFailed`.
 */
export async function rollbackCase1(args: RollbackCase1Args): Promise<RollbackCase1Result> {
  const limit = args.pageSize ?? 100;

  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB scan.go return type is not in d.ts
  const v2Scan = (args.migration.to as any).scan as {
    go: (opts: {
      cursor?: string | null;
      limit?: number;
      consistent?: boolean;
    }) => Promise<{ data: Record<string, unknown>[]; cursor: string | null }>;
  };

  let cursor: string | null = null;

  do {
    const page = await v2Scan.go({ cursor, limit, consistent: CONSISTENT_READ });
    const records = page.data;

    if (records.length > 0) {
      for (const _r of records) {
        args.audit.incrementScanned();
      }

      const result = await batchFlushRollback({
        migration: args.migration,
        client: args.client,
        tableName: args.tableName,
        v2Deletes: records,
      });

      args.audit.addDeleted(result.written);
    }

    cursor = page.cursor;
  } while (cursor !== null);

  return {};
}
