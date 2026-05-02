import type { Service } from 'electrodb';
import type { MigrationStateEntity } from '../entities/migration-state.js';
import type { MigrationsEntity } from '../entities/migrations.js';
import {
  ElectroDBMigrationError,
  LockLostError,
  MigrationFailedError,
  RequiresRollbackError,
} from '../errors.js';
import type { ApplyOptions, MigrationProgressEvent } from '../types.js';
import { fingerprint } from './fingerprint.js';
import { getMigrationStatus } from './get-migration-status.js';
import { acquireRunnerMutex, heartbeatRunnerMutex, releaseRunnerMutex } from './lock.js';
import { decideApply } from './state-machine.js';
import { type ItemCounts, markApplied, markFailed } from './state-mutations.js';

export type ApplyContext = {
  // biome-ignore lint/suspicious/noExplicitAny: Service generics are user-entity-shaped
  service: Service<any>;
  migrationsEntity: MigrationsEntity;
  migrationStateEntity: MigrationStateEntity;
  appliedBy: string;
  staleThresholdMs: number;
  heartbeatMs: number;
  acquireWaitMs: number;
};

// Reads the version from a defined migration's source/target Entity.
// ElectroDB normalizes `model.version` to a string; we trust that.
// biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity generic propagation
const versionOf = (entity: any): string => String(entity.schema.model.version);

// biome-ignore lint/suspicious/noExplicitAny: same
const fingerprintOf = (entity: any): string => fingerprint(entity.schema.model);

// Walks v1 records, transforms via up(), writes v2 records.
// Lock is acquired once per migration; heartbeats run for the duration.
// On any failure inside the scan/transform/write loop the migration row is
// flipped to status='failed' and a MigrationFailedError is thrown wrapping
// the cause. The lock is released either way (transactionally on success or
// failure; via best-effort releaseRunnerMutex when pre-write hasn't happened).
//
// autoRelease (default false): when true, a successful apply also clears any
// existing deployment block for this migration. When false, the migration's id
// is appended to deploymentBlockedIds — the runner mutex still releases, but
// the guard wrapper keeps blocking traffic until the operator calls
// releaseDeploymentBlock(). This decouples "concurrency mutex" from "traffic
// gate" so workflows can do migrate → deploy → release.
export const applyMigrations = async (ctx: ApplyContext, opts: ApplyOptions): Promise<void> => {
  const concurrent = opts.concurrent ?? 1;
  const autoRelease = opts.autoRelease ?? false;

  for (const migration of opts.migrations) {
    const existing = await getMigrationStatus(ctx.migrationsEntity, migration.id);
    const decision = decideApply(existing?.status);

    if (decision.kind === 'skip') continue;
    if (decision.kind === 'requires-rollback') {
      throw new RequiresRollbackError({
        migrationId: migration.id,
        currentStatus: decision.status,
      });
    }

    await runOne(ctx, migration, opts.onProgress, concurrent, autoRelease);
  }
};

const runOne = async (
  ctx: ApplyContext,
  // biome-ignore lint/suspicious/noExplicitAny: same as ApplyOptions
  migration: any,
  onProgress: ((e: MigrationProgressEvent) => void) | undefined,
  concurrent: number,
  autoRelease: boolean,
): Promise<void> => {
  const { refId } = await acquireRunnerMutex(ctx.migrationStateEntity, {
    operation: 'apply',
    migrationId: migration.id,
    appliedBy: ctx.appliedBy,
    staleThresholdMs: ctx.staleThresholdMs,
    acquireWaitMs: ctx.acquireWaitMs,
  });
  onProgress?.({ type: 'lock-acquired', refId, operation: 'apply', migrationId: migration.id });

  let migrationRowWritten = false;
  let hbTimer: NodeJS.Timeout | undefined;
  let heartbeatLost: LockLostError | null = null;
  const counts: ItemCounts = { scanned: 0, migrated: 0, skipped: 0, failed: 0 };
  const startTs = Date.now();

  try {
    // Pre-write the pending row with metadata so failures land on a real row.
    await ctx.migrationsEntity
      .put({
        id: migration.id,
        status: 'pending',
        fromVersion: versionOf(migration.from),
        toVersion: versionOf(migration.to),
        entityName: migration.entityName,
        fingerprint: fingerprintOf(migration.to),
      })
      .go();
    migrationRowWritten = true;

    hbTimer = setInterval(() => {
      heartbeatRunnerMutex(ctx.migrationStateEntity, refId)
        .then(() => onProgress?.({ type: 'heartbeat', refId, at: new Date().toISOString() }))
        .catch((e: unknown) => {
          if (e instanceof LockLostError) heartbeatLost = e;
        });
    }, ctx.heartbeatMs);

    onProgress?.({ type: 'operation-start', operation: 'apply', migrationId: migration.id });

    let cursor: string | undefined;
    let page = 0;

    while (true) {
      if (heartbeatLost) throw heartbeatLost;

      const goOpts: { cursor?: string } = {};
      if (cursor !== undefined) goOpts.cursor = cursor;
      const res = await migration.from.scan.go(goOpts);
      page += 1;
      counts.scanned += res.data.length;
      onProgress?.({ type: 'scan-page', page, count: res.data.length });

      if (res.data.length > 0) {
        const transformed = await Promise.all(
          // biome-ignore lint/suspicious/noExplicitAny: scan result data is generic
          res.data.map((item: any) => migration.up(item)),
        );
        onProgress?.({ type: 'transform-batch', count: transformed.length });

        await migration.to.put(transformed).go({ concurrent });
        counts.migrated += transformed.length;
        onProgress?.({ type: 'write-batch', count: transformed.length });
      }

      if (!res.cursor) break;
      cursor = res.cursor;
    }

    if (heartbeatLost) throw heartbeatLost;

    // Stop heartbeat BEFORE the commit so a late heartbeat doesn't race the
    // transaction clearing lockRefId and surface a spurious LockLostError.
    clearInterval(hbTimer);
    hbTimer = undefined;

    await markApplied(ctx.service, {
      migrationId: migration.id,
      refId,
      appliedBy: ctx.appliedBy,
      itemCounts: counts,
      autoRelease,
    });

    onProgress?.({
      type: 'operation-complete',
      operation: 'apply',
      migrationId: migration.id,
      durationMs: Date.now() - startTs,
    });
    onProgress?.({ type: 'lock-released', refId });
  } catch (err) {
    if (hbTimer !== undefined) {
      clearInterval(hbTimer);
      hbTimer = undefined;
    }

    if (migrationRowWritten) {
      // Persist failure for the next runner to see and release the mutex
      // atomically. Best-effort: if the transaction itself fails (e.g., lock
      // was stolen), the original error is still what reaches the caller.
      try {
        await markFailed(ctx.service, {
          migrationId: migration.id,
          refId,
          itemCounts: counts,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        onProgress?.({ type: 'lock-released', refId });
      } catch {
        // best effort
      }
    } else {
      // Pre-write hadn't completed — no _migrations row exists; just release
      // the lock so the next runner can proceed.
      try {
        await releaseRunnerMutex(ctx.migrationStateEntity, refId);
        onProgress?.({ type: 'lock-released', refId });
      } catch {
        // best effort
      }
    }

    onProgress?.({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    });
    if (err instanceof ElectroDBMigrationError) throw err;
    throw new MigrationFailedError({ migrationId: migration.id, cause: err });
  }
};
