import { MIGRATION_STATE_ID } from '../entities/migration-state.js';
import { createMigrationsService } from '../entities/service.js';
import type {
  ApplyOptions,
  CreateMigrationsClientOptions,
  EnsureAppliedOptions,
  FinalizeOptions,
  GetStatusOptions,
  MigrationBlockReason,
  MigrationGuardState,
  MigrationLockState,
  MigrationRecord,
  ReleaseDeploymentBlockOptions,
  RollbackOptions,
} from '../types.js';
import { defaultAppliedBy } from './applied-by.js';
import type { ApplyContext } from './apply-migrations.js';
import { applyMigrations } from './apply-migrations.js';
import { ensureMigrationsApplied } from './ensure-migrations-applied.js';
import { finalizeMigration } from './finalize-migration.js';
import { getMigrationStatus } from './get-migration-status.js';
import { getLockState, getStateRow } from './lock.js';
import { reconcileState as reconcileStateImpl } from './reconcile-state.js';
import {
  releaseAllDeploymentBlocks as releaseAllImpl,
  releaseDeploymentBlock as releaseDeploymentBlockImpl,
} from './release-deployment-block.js';
import { rollbackMigration } from './rollback-migration.js';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TEN_SECONDS_MS = 10_000;

// The single public entry point. Constructs internal entities once and returns
// a stateful client whose methods delegate to the per-step modules.
export const createMigrationsClient = (config: CreateMigrationsClientOptions) => {
  const { service, migrations, migrationState } = createMigrationsService(
    config.client,
    config.table,
    config.identifiers,
  );

  const ctx: ApplyContext = {
    service,
    migrationsEntity: migrations,
    migrationStateEntity: migrationState,
    appliedBy: config.appliedBy ?? defaultAppliedBy(),
    staleThresholdMs: config.staleThresholdMs ?? FOUR_HOURS_MS,
    heartbeatMs: config.heartbeatMs ?? TEN_SECONDS_MS,
    acquireWaitMs: config.acquireWaitMs ?? TEN_SECONDS_MS,
  };

  const apply = (opts: ApplyOptions): Promise<void> => applyMigrations(ctx, opts);
  const finalize = (opts: FinalizeOptions): Promise<void> => finalizeMigration(ctx, opts);
  const rollback = (opts: RollbackOptions): Promise<void> => rollbackMigration(ctx, opts);

  const getStatus = (opts: GetStatusOptions): Promise<MigrationRecord | undefined> =>
    getMigrationStatus(migrations, opts.migrationId);

  const fetchLockState = (): Promise<MigrationLockState> =>
    getLockState(migrationState, ctx.staleThresholdMs);

  // Single GetItem on the aggregate state row gives us everything the guard
  // needs. The optional enrichment for `failedMigrations[].error` reads each
  // failed migration's row — typically zero extra reads (no failures), at
  // most a small bounded fan-out.
  const fetchGuardState = async (): Promise<MigrationGuardState> => {
    const row = await getStateRow(migrationState);
    if (!row) return { blocked: false };

    const reasons: MigrationBlockReason[] = [];
    const lockHeld = row.lockRefId !== undefined;
    if (lockHeld) reasons.push('locked');
    if (row.failedIds.length > 0) reasons.push('failed-migration');
    if (row.deploymentBlockedIds.length > 0) reasons.push('deployment-block');

    if (reasons.length === 0) return { blocked: false };

    const blocked: Extract<MigrationGuardState, { blocked: true }> = {
      blocked: true,
      reasons,
    };

    if (lockHeld) {
      const lock = await fetchLockState();
      if (lock.locked) blocked.lock = lock;
    }

    if (row.failedIds.length > 0) {
      const failedMigrations = await Promise.all(
        row.failedIds.map(async (id) => {
          const r = await getMigrationStatus(migrations, id);
          return r?.error !== undefined ? { id, error: r.error } : { id };
        }),
      );
      blocked.failedMigrations = failedMigrations;
    }

    if (row.deploymentBlockedIds.length > 0) {
      blocked.deploymentBlockedIds = row.deploymentBlockedIds;
    }

    return blocked;
  };

  const ensureApplied = (opts: EnsureAppliedOptions): Promise<void> =>
    ensureMigrationsApplied(ctx, opts);

  const releaseDeploymentBlock = (opts: ReleaseDeploymentBlockOptions): Promise<void> =>
    releaseDeploymentBlockImpl(migrationState, opts.migrationId);

  const releaseAllDeploymentBlocks = (): Promise<void> => releaseAllImpl(migrationState);

  const reconcileState = (): Promise<void> => reconcileStateImpl(migrations, migrationState);

  // Ops escape hatch: clears the lock fields on the state row regardless of
  // refId. Preserves failedIds / deploymentBlockedIds / inFlightIds — those
  // are auditable state, not lock state. Useful when a runner crashed without
  // releasing and the heartbeat hasn't aged enough for stale takeover.
  const forceUnlock = async (): Promise<void> => {
    const now = new Date().toISOString();
    await migrationState
      .update({ id: MIGRATION_STATE_ID })
      .remove([
        'lockHolder',
        'lockRefId',
        'lockAcquiredAt',
        'lockOperation',
        'lockMigrationId',
        'heartbeatAt',
      ])
      .set({ updatedAt: now })
      .go();
  };

  return {
    apply,
    finalize,
    rollback,
    getStatus,
    getLockState: fetchLockState,
    getGuardState: fetchGuardState,
    ensureApplied,
    releaseDeploymentBlock,
    releaseAllDeploymentBlocks,
    reconcileState,
    forceUnlock,
    // Underlying entities exposed for advanced use (custom queries, tests).
    // Prefer the methods above for normal flow.
    migrationsEntity: migrations,
    migrationStateEntity: migrationState,
  };
};

export type MigrationsClient = ReturnType<typeof createMigrationsClient>;
