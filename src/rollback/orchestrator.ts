/**
 * Rollback orchestrator — the single entry point that composes Wave 1+2 modules
 * into the end-to-end rollback lifecycle.
 *
 * RBK-02, RBK-03, RBK-04, RBK-05, RBK-06, RBK-07, RBK-08, RBK-09, RBK-10, RBK-11, RBK-12.
 *
 * **Order invariants (DO NOT REORDER):**
 *   1. `checkPreconditions` BEFORE `acquireLock` (Pitfall 9.1 — no lock on refusal).
 *   2. `acquireLock` → `startLockHeartbeat` → `sleep(acquireWaitMs)` [LCK-04 / Pitfall 1].
 *   3. Strategy / Case 1 dispatch AFTER sleep.
 *   4. `audit.assertInvariant()` BEFORE `transitionToReleaseMode` (RBK-12 / Pitfall 4).
 *   5. `sched.stop()` in `finally{}` — ALWAYS runs (Pitfall 4 / Pitfall 10).
 *
 * **OQ9 (Plan 05-01):** `acquireLock({mode:'rollback'})` permits entry from
 * `{free, release, failed, active-stale}` states — the orchestrator does NOT
 * need to gate on lockState. Case 2 and Case 3 rollbacks work without a
 * prior explicit `unlock`.
 *
 * **Lock state transitions:**
 *   - Success: `free → rollback → release`
 *   - Error:   `free → rollback → failed`
 *
 * **Audit-row mapping (WARNING 1):**
 *   apply:    itemCounts.migrated = records put as v2  (forward direction)
 *   rollback: itemCounts.migrated = records put as v1  (reverse direction = audit.reverted)
 *
 * The mapping `audit.reverted → itemCounts.migrated` is therefore deliberate.
 * It is pinned at compile time by `tests/unit/rollback/audit-row-shape-types.test-d.ts`.
 *
 * **Pitfall 9 — rollbackStrategy ALWAYS written on the success path:**
 * `transitionToReleaseMode` is called with `rollbackStrategy: args.strategy` on
 * every success code path so the `_migrations` audit row always records which
 * strategy was used. A future change that omits the field will fail the
 * `tests/integration/rollback/audit-row-shape.test.ts` assertions.
 *
 * **Post-failure state (INFO 1):**
 * When the strategy succeeds but `audit.assertInvariant()` throws (count mismatch,
 * RBK-12), `markFailed` runs in the catch block, the lock transitions from
 * `'rollback'` → `'failed'`, but `_migrations.status` REMAINS at its prior value
 * (the orchestrator never reaches `transitionToReleaseMode` on the failure path).
 * Operators MUST re-run `rollback` to converge — the operation is idempotent. The
 * `unlock --run-id` panic-button path then patches `_migrations.status='failed'`
 * per OQ2 (Plan 05-11) if the operator chooses to abandon. This is consistent with
 * apply-flow's behavior.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { acquireLock, startLockHeartbeat } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import { markFailed, transitionToReleaseMode } from '../state-mutations/index.js';
import { sleep } from '../runner/sleep.js';
import { checkPreconditions } from './preconditions.js';
import { classifyTypeTable } from './type-table.js';
import { createRollbackAudit, type RollbackItemCounts } from './audit.js';
import { executeProjected } from './strategies/projected.js';
import { executeSnapshot, type ExecuteSnapshotArgs } from './strategies/snapshot.js';
import { executeFillOnly } from './strategies/fill-only.js';
import { executeCustom } from './strategies/custom.js';
import { rollbackCase1 } from './case-1-flow.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Arguments accepted by {@link rollback}.
 *
 * Mirrors `ApplyFlowArgs` from `src/runner/apply-flow.ts` with rollback-specific
 * fields:
 *   - `strategy` — which of the four rollback strategies to use.
 *   - `yes` — skip the interactive snapshot prompt (--yes flag; still emits to stderr).
 *   - `io` — injection point for `executeSnapshot`'s prompt + stderr (used in tests
 *     and by the CLI to wire a custom confirm function).
 */
export interface RollbackArgs {
  service: MigrationsServiceBundle;
  config: ResolvedConfig;
  client: DynamoDBDocumentClient;
  tableName: string;
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  strategy: 'projected' | 'snapshot' | 'fill-only' | 'custom';
  runId: string;
  holder: string;
  /** Skip interactive snapshot prompt. DATA-LOSS warning still emitted to stderr (Pitfall 8). */
  yes?: boolean;
  /** stderr writer + confirm injection for `executeSnapshot` (WARNING 4 — pass by reference). */
  io?: ExecuteSnapshotArgs['io'];
}

/**
 * Result returned by {@link rollback} on success.
 *
 * Contains the count-audit snapshot captured at the end of the rollback run.
 */
export interface RollbackResult {
  itemCounts: RollbackItemCounts;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute a rollback of the given migration against DDB Local / AWS DynamoDB.
 *
 * This function is the single entry point that composes all Wave 1+2 primitives
 * into the full rollback lifecycle:
 *
 * Step 1 — `checkPreconditions` (BEFORE acquireLock):
 *   - Reads all `_migrations` rows + lock row.
 *   - Returns `{kind:'proceed', case:'case-1'|'case-2'|'case-3', targetRow}` or `{kind:'refuse', error}`.
 *   - On refusal: throws `error` immediately — no lock, no heartbeat, no DDB writes.
 *
 * Step 2 — Lock acquire + heartbeat:
 *   - `acquireLock({mode:'rollback', ...})` — OQ9 widening accepts `release`/`failed` states.
 *   - `startLockHeartbeat(...)` — starts the lock heartbeat scheduler.
 *
 * Step 3 — LCK-04 wait window (Pitfall 1 — DO NOT REMOVE):
 *   - `sleep(config.lock.acquireWaitMs)` — gives guarded clients time to refresh.
 *
 * Step 4 — Dispatch by lifecycle case:
 *   - Case 1: `rollbackCase1(...)` — lossless delete-only path (no `down` required).
 *   - Case 2/3: `classifyTypeTable(...)` → `executeXxx(...)` per `args.strategy`.
 *
 * Step 5 — Count audit invariant (RBK-12):
 *   - `audit.assertInvariant()` — throws `EDBRollbackCountMismatchError` on mismatch.
 *   - MUST run BEFORE `transitionToReleaseMode`.
 *
 * Step 6 — Release transition (Pitfall 9 — rollbackStrategy ALWAYS present):
 *   - `transitionToReleaseMode({outcome:'reverted', rollbackStrategy: args.strategy, itemCounts: ...})`
 *   - WARNING 1: `itemCounts.migrated = audit.reverted` (reverse-direction mapping).
 *
 * Catch (CR-04 mirror):
 *   - Best-effort `markFailed(...).catch(...)` — non-fatal; original error re-thrown.
 *
 * Finally (Pitfall 4 / Pitfall 10):
 *   - `sched.stop()` — ALWAYS stops the heartbeat scheduler on every exit path.
 *
 * @param args - {@link RollbackArgs}
 * @returns {@link RollbackResult} — contains the count-audit snapshot.
 * @throws The preconditions error, EDBMigrationLockHeldError, EDBRollbackCountMismatchError,
 *   or any error thrown by the strategy executor.
 */
export async function rollback(args: RollbackArgs): Promise<RollbackResult> {
  // -------------------------------------------------------------------------
  // Step 1 — Preconditions gate (BEFORE acquireLock).
  //
  // On refusal: throw immediately — no lock acquired, no DDB writes, no markFailed.
  // -------------------------------------------------------------------------
  const decision = await checkPreconditions({
    service: args.service,
    migration: args.migration,
    strategy: args.strategy,
  });

  if (decision.kind === 'refuse') {
    throw decision.error;
  }

  // -------------------------------------------------------------------------
  // Step 2 — Acquire lock + start heartbeat (OQ9 widening: mode='rollback').
  // -------------------------------------------------------------------------
  await acquireLock(args.service, args.config, {
    mode: 'rollback',
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

  const audit = createRollbackAudit();

  try {
    // -----------------------------------------------------------------------
    // Step 3 — LCK-04 wait window (Pitfall 1 — DO NOT REMOVE).
    // -----------------------------------------------------------------------
    await sleep(args.config.lock.acquireWaitMs);

    // -----------------------------------------------------------------------
    // Step 4 — Dispatch by lifecycle case.
    // -----------------------------------------------------------------------
    if (decision.case === 'case-1') {
      // Case 1: pre-release, lossless — delete v2 records; v1 is intact.
      // migration.down is NOT required (RBK-03).
      await rollbackCase1({
        migration: args.migration,
        client: args.client,
        tableName: args.tableName,
        audit,
      });
    } else {
      // Case 2 or Case 3: strategy-driven, type-table-classified.
      const classify = classifyTypeTable({
        migration: args.migration,
      });

      switch (args.strategy) {
        case 'projected':
          await executeProjected({ classify, migration: args.migration, client: args.client, tableName: args.tableName, audit });
          break;
        case 'snapshot':
          // WARNING 4 — pass args.io by reference (NOT a copy or wrapper).
          // The unit test asserts `capturedArgs.io.confirm === args.io.confirm`.
          await executeSnapshot({
            classify,
            migration: args.migration,
            client: args.client,
            tableName: args.tableName,
            audit,
            ...(args.yes !== undefined ? { yes: args.yes } : {}),
            ...(args.io ? { io: args.io } : {}),
          });
          break;
        case 'fill-only':
          await executeFillOnly({ classify, migration: args.migration, client: args.client, tableName: args.tableName, audit });
          break;
        case 'custom':
          await executeCustom({ classify, migration: args.migration, client: args.client, tableName: args.tableName, audit });
          break;
        default: {
          const exhaustive: never = args.strategy;
          throw new Error(`Unknown rollback strategy: ${String(exhaustive)}`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 5 — Count audit invariant (RBK-12).
    // MUST run BEFORE transitionToReleaseMode (INFO 1: see module JSDoc).
    // -----------------------------------------------------------------------
    audit.assertInvariant();

    // -----------------------------------------------------------------------
    // Step 6 — Transition to release mode (Pitfall 9 — rollbackStrategy ALWAYS present).
    //
    // WARNING 1 — Audit-row mapping:
    //   apply:    itemCounts.migrated = records put as v2  (forward direction)
    //   rollback: itemCounts.migrated = records put as v1  (reverse direction = audit.reverted)
    //
    // The TS type-test at tests/unit/rollback/audit-row-shape-types.test-d.ts pins
    // the assignability of `RollbackItemCounts['reverted']` to
    // `TransitionArgs['itemCounts']['migrated']` at compile time.
    // -----------------------------------------------------------------------
    const snap = audit.snapshot();
    await transitionToReleaseMode(args.service, {
      runId: args.runId,
      migId: args.migration.id,
      outcome: 'reverted',
      // WARNING 1: audit.reverted → itemCounts.migrated (see JSDoc above)
      itemCounts: {
        scanned: snap.scanned,
        migrated: snap.reverted, // deliberate: reverse-direction 'migrated' = records put as v1
        deleted: snap.deleted,
        skipped: snap.skipped,
        failed: snap.failed,
      },
      // Pitfall 9: rollbackStrategy ALWAYS written on success path
      rollbackStrategy: args.strategy,
    });

    return { itemCounts: snap };
  } catch (err) {
    // Best-effort markFailed — its own throw is non-fatal; we re-throw the original cause.
    // Mirrors apply-flow CR-04 disposition (src/runner/apply-flow.ts:55-82).
    await markFailed(args.service, {
      runId: args.runId,
      migId: args.migration.id,
      cause: err,
    }).catch((markFailedErr: unknown) => {
      // eslint-disable-next-line no-console -- diagnostic only; matches heartbeat onAbort CR-04 disposition
      console.error('[electrodb-migrations] rollback: markFailed rejected after run failure:', markFailedErr);
    });

    throw err;
  } finally {
    await sched.stop(); // Pitfall 4 / Pitfall 10 — ALWAYS stop; .stop() is idempotent
  }
}
