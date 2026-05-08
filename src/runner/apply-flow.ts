import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import { MIGRATIONS_SCHEMA_VERSION, type MigrationsServiceBundle } from '../internal-entities/index.js';
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
 * Order (DO NOT REORDER): acquireLock → startHeartbeat → sleep(acquireWaitMs) [LCK-04/Pitfall 1]
 * → applyFlowScanWrite → transitionToReleaseMode.
 *
 * Error path: catch → markFailed → re-throw (Pitfall 4 / RUN-08). NO auto-rollback.
 * try/finally ensures sched.stop() runs on EVERY exit path.
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
 * Scan + transform + write without touching the lock. Used by `apply-batch.ts`
 * for migration #2..N (lock held continuously across the boundary).
 *
 * OQ-2 disposition: `up()` returning null/undefined → `skipped` (not `failed`).
 * RUN-08 fail-fast: `up()` throw bubbles up verbatim; caller calls `markFailed`.
 * RUN-04: `audit.assertInvariant()` runs BEFORE `transitionToReleaseMode`.
 *
 * **`_migrations` row creation (Plan 08 prerequisite):**
 * `transitionToReleaseMode` patches the `_migrations` row (which must exist).
 * This function creates the row with `status: 'pending'` before scanning, so the
 * patch can succeed. The row is upserted (idempotent for repeated apply attempts).
 */
export async function applyFlowScanWrite(args: ApplyFlowArgs): Promise<ApplyFlowResult> {
  // Create the `_migrations` row before scanning. `transitionToReleaseMode`'s
  // transactWrite patches this row (item 1); it must exist. Status is `pending`
  // here and flips to `applied` when the transition completes.
  const from = args.migration.from as unknown as { model: { version: string } };
  const to = args.migration.to as unknown as { model: { version: string } };
  await args.service.migrations
    .upsert({
      id: args.migration.id,
      schemaVersion: MIGRATIONS_SCHEMA_VERSION,
      kind: 'transform',
      status: 'pending',
      entityName: args.migration.entityName,
      fromVersion: from.model.version,
      toVersion: to.model.version,
      // fingerprint is set at `create`/`baseline` time; use a placeholder at apply
      // time when no snapshot is available. Phase 7 validate enforces the fingerprint
      // against the on-disk snapshot; apply does not re-derive it.
      fingerprint: `applied:${args.migration.id}`,
      hasDown: typeof args.migration.down === 'function',
      hasRollbackResolver: typeof args.migration.rollbackResolver === 'function',
    })
    .go();

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
