import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { startLockHeartbeat } from '../lock/index.js';
import { appendInFlight, markFailed } from '../state-mutations/index.js';
import { type ApplyFlowResult, applyFlow, applyFlowScanWrite } from './apply-flow.js';
import { type PendingMigration, isNextPending } from './load-pending.js';
import { transitionReleaseToApply } from './transition-release-to-apply.js';

export interface ApplyBatchArgs {
  service: MigrationsServiceBundle;
  config: ResolvedConfig;
  client: DynamoDBDocumentClient;
  tableName: string;
  /** Pending list, pre-sorted by `(entityName, fromVersion)` ascending. */
  pending: ReadonlyArray<PendingMigration>;
  /** When set, only the named migration is applied; refuses if not next pending (RUN-06). */
  migrationId?: string;
  runId: string;
  holder: string;
  ctx?: unknown;
}

export interface ApplyBatchResult {
  applied: ReadonlyArray<{ migId: string; itemCounts: ApplyFlowResult['itemCounts'] }>;
}

/**
 * RUN-05/06/07 — multi-migration loop.
 *
 * **RUN-07 (no pending):** if `pending.length === 0`, returns `{applied: []}` immediately.
 * The CLI command (Plan 12) prints "No migrations to apply." and exits 0.
 *
 * **RUN-06 (sequence enforcement):** when `migrationId` is set, asserts it is the next
 * pending FOR ITS ENTITY (per-entity scope per Open Question 6). If not, throws an
 * `Error` with `.code = 'EDB_NOT_NEXT_PENDING'` and `.remediation` naming the actual
 * next id. The CLI command surfaces this with `log.err(message, remediation)`.
 *
 * **RUN-05 (multi-migration handoff):** the loop drives one continuous lock cycle:
 *   - Migration 0: full `applyFlow` (acquire + sleep + scan/write + transition).
 *   - Migration N (N>0): `appendInFlight` + `transitionReleaseToApply` + `applyFlowScanWrite`.
 *     The lock is held continuously across the boundary; the heartbeat scheduler
 *     (started by applyFlow at migration 0) keeps refreshing.
 *
 * **End state:** after the last migration's transition, lock is in `release` mode.
 * Operator runs `release` to clear (Plan 12).
 *
 * **Failure semantics:** if migration N (N>0) fails after migration 0 succeeded,
 * the lock is in `apply` state for migration N when the throw fires. markFailed
 * marks the lock `failed` (not `release`) — the operator runs `rollback` to recover
 * the partial state, and `release` won't clear a `failed` lock.
 *
 * **No-heartbeat boundary window (W-03):** Between `applyFlow`'s `sched.stop()`
 * and the next iteration's `startLockHeartbeat(...)` there is a brief window
 * (microseconds in practice; bounded above by the loop body's awaits) during
 * which the lock row receives no heartbeat refresh. This is provably safe
 * because the lock state at that moment is exactly `'release'` — `applyFlow`
 * just called `transitionToReleaseMode`, and the loop's first verb is
 * `appendInFlight` (which preserves `lockState='release'`) followed by
 * `transitionReleaseToApply` (which flips to 'apply' AFTER heartbeat has
 * already restarted). The `'release'` state is NOT in the stale-takeover
 * allowlist (Phase 3 LCK-03), so even arbitrarily long heartbeat staleness
 * cannot allow another runner to take over. AB-10 in apply-batch.test.ts
 * pins this invariant via the call sequence: `applyFlow → startLockHeartbeat
 * → appendInFlight → transitionReleaseToApply → applyFlowScanWrite`.
 */
export async function applyBatch(args: ApplyBatchArgs): Promise<ApplyBatchResult> {
  // RUN-07
  if (args.pending.length === 0) return { applied: [] };

  // RUN-06
  let toApply: ReadonlyArray<PendingMigration>;
  if (args.migrationId !== undefined) {
    if (!isNextPending(args.pending, args.migrationId)) {
      const target = args.pending.find((p) => p.id === args.migrationId);
      if (!target) {
        const err: Error & { code?: string; remediation?: string } = new Error(
          `Migration '${args.migrationId}' is not pending (already applied, or unknown).`,
        );
        err.code = 'EDB_NOT_PENDING';
        err.remediation = 'Run `electrodb-migrations history` to inspect status.';
        throw err;
      }
      const sameEntity = args.pending.filter((p) => p.entityName === target.entityName);
      const nextId = sameEntity[0]!.id;
      const err: Error & { code?: string; remediation?: string } = new Error(
        `Migration '${args.migrationId}' is not the next pending migration for entity ${target.entityName}.`,
      );
      err.code = 'EDB_NOT_NEXT_PENDING';
      err.remediation = `Next pending: ${nextId} (${target.entityName} v${sameEntity[0]!.fromVersion}→v${sameEntity[0]!.toVersion})`;
      throw err;
    }
    const single = args.pending.find((p) => p.id === args.migrationId)!;
    toApply = [single];
  } else {
    toApply = args.pending;
  }

  const applied: { migId: string; itemCounts: ApplyFlowResult['itemCounts'] }[] = [];

  // First migration — full applyFlow (acquire + sleep + scan/write + transition).
  // applyFlow internally manages the heartbeat scheduler (start + stop).
  const first = toApply[0]!;
  const firstResult = await applyFlow({
    service: args.service,
    config: args.config,
    client: args.client,
    tableName: args.tableName,
    migration: first.migration,
    runId: args.runId,
    holder: args.holder,
    ...(args.ctx !== undefined ? { ctx: args.ctx } : {}),
  });
  applied.push({ migId: first.id, itemCounts: firstResult.itemCounts });

  // Migration 2..N — re-start heartbeat (applyFlow stopped it after migration 0)
  // and run scan/write only. The lock is in `release` from applyFlow's final
  // transitionToReleaseMode; we appendInFlight + transitionReleaseToApply to
  // resume in `apply` for the next migration.
  for (let i = 1; i < toApply.length; i++) {
    const next = toApply[i]!;
    const sched = startLockHeartbeat({
      service: args.service,
      config: args.config,
      runId: args.runId,
      migId: next.id,
    });
    try {
      await appendInFlight(args.service, { runId: args.runId, migId: next.id });
      await transitionReleaseToApply(args.service, { runId: args.runId, migId: next.id });
      const result = await applyFlowScanWrite({
        service: args.service,
        config: args.config,
        client: args.client,
        tableName: args.tableName,
        migration: next.migration,
        runId: args.runId,
        holder: args.holder,
        ...(args.ctx !== undefined ? { ctx: args.ctx } : {}),
      });
      applied.push({ migId: next.id, itemCounts: result.itemCounts });
    } catch (err) {
      await markFailed(args.service, {
        runId: args.runId,
        migId: next.id,
        cause: err,
      }).catch((markFailedErr) => {
        // eslint-disable-next-line no-console -- diagnostic only; matches CR-04 disposition
        console.error('[electrodb-migrations] applyBatch: markFailed rejected after run failure:', markFailedErr);
      });
      throw err;
    } finally {
      await sched.stop();
    }
  }

  return { applied };
}
