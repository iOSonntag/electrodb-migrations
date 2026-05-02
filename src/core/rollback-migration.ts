import {
  ElectroDBMigrationError,
  LockLostError,
  MigrationFailedError,
  RollbackNotPossibleError,
} from '../errors.js';
import type { MigrationProgressEvent, RollbackOptions } from '../types.js';
import type { ApplyContext } from './apply-migrations.js';
import { getMigrationStatus } from './get-migration-status.js';
import { acquireRunnerMutex, heartbeatRunnerMutex, releaseRunnerMutex } from './lock.js';
import { type RollbackDecision, decideRollback } from './state-machine.js';
import { markReverted } from './state-mutations.js';

// Reverses a migration. Two paths:
//   • pre-finalize  — v1 is still present (failed or applied, not yet finalized).
//                     We just delete the v2 records; the migration row goes to 'reverted'.
//   • post-finalize — v1 has been deleted. We run down() over v2 to recreate v1,
//                     then delete v2. Requires migration.down or throws.
// 'reverted' is terminal — re-running apply on it requires a future --force reset.
//
// autoRelease (default false): when true, a successful rollback also clears any
// existing deployment block for this migration. When false, the migration's id
// is appended to deploymentBlockedIds — same workflow as apply but in reverse:
// rollback DB → deploy old code → release.
export const rollbackMigration = async (
  ctx: ApplyContext,
  opts: RollbackOptions,
): Promise<void> => {
  const { migration } = opts;
  const concurrent = opts.concurrent ?? 1;
  const onProgress = opts.onProgress;
  const autoRelease = opts.autoRelease ?? false;

  const existing = await getMigrationStatus(ctx.migrationsEntity, migration.id);
  const decision = decideRollback(existing?.status);

  if (decision.kind === 'no-op') return;
  if (decision.kind === 'already-reverted') {
    throw new RollbackNotPossibleError({
      migrationId: migration.id,
      reason: 'already-reverted',
    });
  }
  if (decision.kind === 'post-finalize' && !migration.down) {
    throw new RollbackNotPossibleError({
      migrationId: migration.id,
      reason: 'no-down-fn',
    });
  }

  const { refId } = await acquireRunnerMutex(ctx.migrationStateEntity, {
    operation: 'rollback',
    migrationId: migration.id,
    appliedBy: ctx.appliedBy,
    staleThresholdMs: ctx.staleThresholdMs,
    acquireWaitMs: ctx.acquireWaitMs,
  });
  onProgress?.({ type: 'lock-acquired', refId, operation: 'rollback', migrationId: migration.id });

  let hbTimer: NodeJS.Timeout | undefined;
  let heartbeatLost: LockLostError | null = null;
  const startTs = Date.now();

  try {
    hbTimer = setInterval(() => {
      heartbeatRunnerMutex(ctx.migrationStateEntity, refId)
        .then(() => onProgress?.({ type: 'heartbeat', refId, at: new Date().toISOString() }))
        .catch((e: unknown) => {
          if (e instanceof LockLostError) heartbeatLost = e;
        });
    }, ctx.heartbeatMs);

    onProgress?.({ type: 'operation-start', operation: 'rollback', migrationId: migration.id });

    await runRollbackLoop(decision, migration, concurrent, () => heartbeatLost, onProgress);

    if (heartbeatLost) throw heartbeatLost;

    // Stop heartbeat BEFORE the commit (see apply-migrations note).
    clearInterval(hbTimer);
    hbTimer = undefined;

    await markReverted(ctx.service, {
      migrationId: migration.id,
      refId,
      autoRelease,
    });

    onProgress?.({
      type: 'operation-complete',
      operation: 'rollback',
      migrationId: migration.id,
      durationMs: Date.now() - startTs,
    });
    onProgress?.({ type: 'lock-released', refId });
  } catch (err) {
    if (hbTimer !== undefined) {
      clearInterval(hbTimer);
      hbTimer = undefined;
    }
    // Rollback failure leaves the row in its prior state (applied/failed/finalized);
    // a human should look. Best-effort lock release so the next runner can retry.
    try {
      await releaseRunnerMutex(ctx.migrationStateEntity, refId);
      onProgress?.({ type: 'lock-released', refId });
    } catch {
      // best effort
    }

    onProgress?.({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    });
    if (err instanceof ElectroDBMigrationError) throw err;
    throw new MigrationFailedError({ migrationId: migration.id, cause: err });
  }
};

const runRollbackLoop = async (
  decision: RollbackDecision,
  // biome-ignore lint/suspicious/noExplicitAny: same as ApplyOptions
  migration: any,
  concurrent: number,
  heartbeatLost: () => LockLostError | null,
  onProgress: ((e: MigrationProgressEvent) => void) | undefined,
): Promise<void> => {
  let cursor: string | undefined;
  let page = 0;

  while (true) {
    const lost = heartbeatLost();
    if (lost) throw lost;

    const goOpts: { cursor?: string } = {};
    if (cursor !== undefined) goOpts.cursor = cursor;
    const res = await migration.to.scan.go(goOpts);
    page += 1;
    onProgress?.({ type: 'scan-page', page, count: res.data.length });

    if (res.data.length > 0) {
      if (decision.kind === 'post-finalize') {
        // Recreate v1 records from v2 via down() before deleting v2.
        const restored = await Promise.all(
          // biome-ignore lint/suspicious/noExplicitAny: scan result data is generic
          res.data.map((item: any) => migration.down(item)),
        );
        onProgress?.({ type: 'transform-batch', count: restored.length });
        await migration.from.put(restored).go({ concurrent });
      }
      await migration.to.delete(res.data).go({ concurrent });
      onProgress?.({ type: 'write-batch', count: res.data.length });
    }

    if (!res.cursor) break;
    cursor = res.cursor;
  }
};
