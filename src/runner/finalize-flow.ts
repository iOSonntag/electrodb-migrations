import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { acquireLock, startLockHeartbeat } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import { clearFinalizeMode, isConditionalCheckFailed, markFailed } from '../state-mutations/index.js';
import { type ItemCounts, createCountAudit } from './count-audit.js';
import { iterateV1Records } from './scan-pipeline.js';
import { sleep } from './sleep.js';

export interface FinalizeFlowArgs {
  service: MigrationsServiceBundle;
  config: ResolvedConfig;
  client: DynamoDBDocumentClient;
  tableName: string;
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  runId: string;
  holder: string;
}

export interface FinalizeFlowResult {
  itemCounts: ItemCounts;
}

/**
 * FIN-01/03/04 — finalize orchestrator.
 *
 * Acquires `mode='finalize'` lock (Decision A7: NOT in GATING_LOCK_STATES —
 * app traffic continues). Iterates v1 records and deletes each via the
 * migration's frozen v1 entity. Pitfall 7: concurrent app deletes during
 * finalize-mode cause `ConditionalCheckFailedException`; those count as
 * `skipped`, NOT `failed`. Post-loop: patch `_migrations.status='finalized'`
 * THEN `clear({runId})`. FIN-04: no auto-rollback hook fires.
 *
 * Each successful v1 delete increments `audit.addDeleted(1)`. Apply-time
 * `migrated` is left at 0 for finalize rows so consumers of `history --json`
 * can distinguish apply-time writes from finalize-time reaps (WR-05).
 */
export async function finalizeFlow(args: FinalizeFlowArgs): Promise<FinalizeFlowResult> {
  await acquireLock(args.service, args.config, {
    mode: 'finalize',
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
    // LCK-04 mirror — even though finalize is non-gating (Decision A7), the
    // sleep allows stale-cached guarded processes time to refresh.
    await sleep(args.config.lock.acquireWaitMs);

    const audit = createCountAudit();

    for await (const page of iterateV1Records(args.migration)) {
      for (const v1 of page) {
        audit.incrementScanned();
        try {
          // ElectroDB's delete chain accepts the full record and extracts PK fields.
          await (
            args.migration.from as unknown as {
              delete: (r: unknown) => { go: () => Promise<unknown> };
            }
          )
            .delete(v1)
            .go();
          audit.addDeleted(1); // finalize-only counter; apply-time `migrated` stays 0.
        } catch (err) {
          if (isConditionalCheckFailed(err)) {
            // Pitfall 7 — concurrent app delete during finalize-mode (Decision A7).
            audit.incrementSkipped();
            continue;
          }
          audit.incrementFailed(); // RUN-08 mirror — fail-fast on unexpected errors.
          throw err;
        }
      }
    }

    audit.assertInvariant();

    // Two-step post-loop: patch finalized THEN clear lock (T-04-10-03).
    const now = new Date().toISOString();
    await args.service.migrations.patch({ id: args.migration.id }).set({ status: 'finalized', finalizedAt: now }).go();

    // FIN-03: clear the finalize-mode lock back to 'free' using the dedicated
    // clearFinalizeMode verb (condition: lockState='finalize' AND lockRunId=:runId).
    // `clear()` is for the apply/rollback release-mode path only (lockState='release').
    await clearFinalizeMode(args.service, { runId: args.runId });

    return { itemCounts: audit.snapshot() };
  } catch (err) {
    await markFailed(args.service, {
      runId: args.runId,
      migId: args.migration.id,
      cause: err,
    }).catch((markFailedErr) => {
      // eslint-disable-next-line no-console -- diagnostic only; CR-04 disposition
      console.error('[electrodb-migrations] finalizeFlow: markFailed rejected:', markFailedErr);
    });
    throw err;
  } finally {
    await sched.stop();
  }
}

