import { ElectroDBMigrationError, LockLostError, MigrationFailedError } from '../errors.js';
import type { FinalizeOptions } from '../types.js';
import type { ApplyContext } from './apply-migrations.js';
import { getMigrationStatus } from './get-migration-status.js';
import { acquireRunnerMutex, heartbeatRunnerMutex, releaseRunnerMutex } from './lock.js';
import { decideFinalize } from './state-machine.js';
import { markFinalized } from './state-mutations.js';

// Deletes all v1 records for the given migration and flips status to finalized.
// Pre-finalize, v1+v2 coexist; after finalize, only v2 remains. This is the
// permanent commitment — rolling back afterward requires down() and rebuilds v1.
//
// No count check: between apply and finalize, the app may have legitimately
// written new v2 records, so v1.count !== v2.count is expected.
//
// Finalize does not take an autoRelease option — finalize doesn't gate
// deploys (the deploy already happened during the bake window).
export const finalizeMigration = async (
  ctx: ApplyContext,
  opts: FinalizeOptions,
): Promise<void> => {
  const { migration } = opts;
  const concurrent = opts.concurrent ?? 1;
  const onProgress = opts.onProgress;

  const existing = await getMigrationStatus(ctx.migrationsEntity, migration.id);
  const decision = decideFinalize(existing?.status);

  if (decision.kind === 'skip') return; // already finalized
  if (decision.kind === 'invalid-state') {
    throw new ElectroDBMigrationError(
      `Cannot finalize migration ${migration.id}: current status is ${decision.status ?? '(none)'}; expected 'applied'`,
    );
  }

  const { refId } = await acquireRunnerMutex(ctx.migrationStateEntity, {
    operation: 'finalize',
    migrationId: migration.id,
    appliedBy: ctx.appliedBy,
    staleThresholdMs: ctx.staleThresholdMs,
    acquireWaitMs: ctx.acquireWaitMs,
  });
  onProgress?.({ type: 'lock-acquired', refId, operation: 'finalize', migrationId: migration.id });

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

    onProgress?.({ type: 'operation-start', operation: 'finalize', migrationId: migration.id });

    let cursor: string | undefined;
    let page = 0;
    while (true) {
      if (heartbeatLost) throw heartbeatLost;

      const goOpts: { cursor?: string } = {};
      if (cursor !== undefined) goOpts.cursor = cursor;
      const res = await migration.from.scan.go(goOpts);
      page += 1;
      onProgress?.({ type: 'scan-page', page, count: res.data.length });

      if (res.data.length > 0) {
        await migration.from.delete(res.data).go({ concurrent });
        onProgress?.({ type: 'write-batch', count: res.data.length });
      }

      if (!res.cursor) break;
      cursor = res.cursor;
    }

    if (heartbeatLost) throw heartbeatLost;

    // Stop heartbeat BEFORE the commit (see apply-migrations note).
    clearInterval(hbTimer);
    hbTimer = undefined;

    await markFinalized(ctx.service, {
      migrationId: migration.id,
      refId,
    });

    onProgress?.({
      type: 'operation-complete',
      operation: 'finalize',
      migrationId: migration.id,
      durationMs: Date.now() - startTs,
    });
    onProgress?.({ type: 'lock-released', refId });
  } catch (err) {
    if (hbTimer !== undefined) {
      clearInterval(hbTimer);
      hbTimer = undefined;
    }
    // Finalize doesn't have a "failed" terminal status on the migration row
    // (the row stays at 'applied'); just release the lock so another runner
    // can retry. Best-effort.
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
