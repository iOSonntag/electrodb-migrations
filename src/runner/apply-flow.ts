import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { acquireLock, startLockHeartbeat } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import { markFailed, transitionToReleaseMode } from '../state-mutations/index.js';
import { batchFlushV2 } from './batch-flush.js';
import { type ItemCounts, createCountAudit } from './count-audit.js';
import { iterateV1Records } from './scan-pipeline.js';
import { sleep } from './sleep.js';

export interface ApplyFlowArgs {
  service: MigrationsServiceBundle;
  config: ResolvedConfig;
  client: DynamoDBDocumentClient;
  tableName: string;
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  runId: string;
  holder: string;
  /** Optional ctx for `up()` — Phase 6 wires the cross-entity reader; v0.1 leaves undefined. */
  ctx?: unknown;
}

export interface ApplyFlowResult {
  itemCounts: ItemCounts;
}

/**
 * RUN-01/02/04/08 — single-migration apply orchestrator.
 *
 * Composition order (DO NOT REORDER):
 * 1. `acquireLock(mode='apply')` — Phase 3 verb; throws `EDBMigrationLockHeldError` if held.
 * 2. `startLockHeartbeat(...)` — Phase 1 self-rescheduling setTimeout chain; survives Lambda freeze/thaw.
 * 3. `await sleep(config.lock.acquireWaitMs)` — LCK-04 / Pitfall 1. DO NOT REMOVE. Without this,
 *    guarded app processes whose lock-cache TTL is mid-window may still serve traffic during
 *    the migration's first batch — silent corruption window.
 * 4. `applyFlowScanWrite(...)` — scan v1, transform via `migration.up`, batch-write v2.
 *    See its docstring for the per-record loop semantics.
 * 5. `transitionToReleaseMode(outcome='applied', itemCounts)` — Phase 3 verb; flips lockState='release'.
 *
 * Error path (Pitfall 4 / RUN-08):
 * - Any throw inside steps 3-5 → catch → `markFailed` → re-throw. NO auto-rollback.
 * - `try/finally` ensures `sched.stop()` runs on EVERY exit. Heartbeat outliving the runner is
 *   the same scenario as CR-04 (resolved 2026-05-08); this orchestrator inherits the fix.
 *
 * **LCK-04 note for multi-migration apply:** `applyFlow` is called ONLY for migration 0.
 * Subsequent migrations go through `applyFlowScanWrite` directly (via apply-batch.ts);
 * they do NOT sleep because the lock is continuously held in release-mode across the
 * boundary and `acquireWaitMs` was already satisfied at boundary 0.
 */
export async function applyFlow(args: ApplyFlowArgs): Promise<ApplyFlowResult> {
  await acquireLock(args.service, args.config, {
    mode: 'apply',
    migId: args.migration.id,
    runId: args.runId,
    holder: args.holder,
  });
  const sched = startLockHeartbeat({
    service: args.service,
    config: args.config,
    runId: args.runId,
    migId: args.migration.id,
  });

  try {
    await sleep(args.config.lock.acquireWaitMs); // LCK-04 — DO NOT REMOVE (Pitfall 1)
    return await applyFlowScanWrite(args);
  } catch (err) {
    // Best-effort markFailed — its own throw is non-fatal; we re-throw the original cause.
    await markFailed(args.service, {
      runId: args.runId,
      migId: args.migration.id,
      cause: err,
    }).catch((markFailedErr) => {
      // eslint-disable-next-line no-console -- diagnostic only; matches heartbeat onAbort CR-04 disposition
      console.error('[electrodb-migrations] applyFlow: markFailed rejected after run failure:', markFailedErr);
    });
    throw err;
  } finally {
    await sched.stop(); // Pitfall 4 — ALWAYS stop; .stop() is idempotent
  }
}

/**
 * Scan + transform + write the migration WITHOUT touching the lock. Used directly by
 * `apply-batch.ts` for migration #2..N within a single `apply` invocation (the lock is
 * held continuously across the boundary).
 *
 * **Caller's responsibility:** the lock MUST already be in `apply` state with this
 * runner's runId. apply-batch achieves this by calling `transitionReleaseToApply`
 * BEFORE this function. apply-flow.ts (the wrapping orchestrator) achieves this via
 * `acquireLock` + `sleep`.
 *
 * **Open Question 2 disposition (Plan 04-04):** if `migration.up(record)` returns
 * `null` or `undefined`, the record is counted as `skipped` (NOT `failed`). The
 * runner moves on to the next record.
 *
 * **RUN-08 fail-fast:** if `migration.up(record)` THROWS, the throw bubbles up
 * verbatim. apply-flow's catch path calls `markFailed`. This function does NOT
 * call `markFailed` itself — it's stateless wrt lock state.
 *
 * **Count audit (RUN-04):** before returning, asserts
 * `scanned == migrated + skipped + failed`. Violation throws (the runner has a bug).
 */
export async function applyFlowScanWrite(args: ApplyFlowArgs): Promise<ApplyFlowResult> {
  const audit = createCountAudit();

  for await (const page of iterateV1Records(args.migration)) {
    const v2Batch: Record<string, unknown>[] = [];
    for (const v1 of page) {
      audit.incrementScanned();
      let v2: unknown;
      try {
        v2 = await args.migration.up(v1, args.ctx);
      } catch (err) {
        audit.incrementFailed();
        throw err; // RUN-08 fail-fast
      }
      if (v2 === null || v2 === undefined) {
        audit.incrementSkipped();
        continue;
      }
      v2Batch.push(v2 as Record<string, unknown>);
    }
    if (v2Batch.length > 0) {
      const result = await batchFlushV2({
        migration: args.migration,
        client: args.client,
        tableName: args.tableName,
        records: v2Batch,
      });
      audit.addMigrated(result.written);
    }
  }

  audit.assertInvariant(); // RUN-04 — refuses to mark applied if invariant broken

  await transitionToReleaseMode(args.service, {
    runId: args.runId,
    migId: args.migration.id,
    outcome: 'applied',
    itemCounts: audit.snapshot(),
  });

  return { itemCounts: audit.snapshot() };
}
