import type { Service } from 'electrodb';
import { MIGRATION_STATE_ID } from '../entities/migration-state.js';

// Transactional state-mutation helpers. Every lifecycle transition that flips
// a `_migrations` row's status also updates the `_migration_state` aggregate
// row in the same TransactWriteItems, so the guard sees a consistent view.
//
// Each mutation is gated by `where(eq(lockRefId, refId))` on the state row:
// the runner asserts it still holds the mutex at commit time. If a stale
// takeover happened mid-loop, the transaction rolls back and the migration
// row stays at `pending` (apply) or its prior status (finalize/rollback) for
// the next runner to triage.

// biome-ignore lint/suspicious/noExplicitAny: Service generics are user-entity-shaped; the migrations entity is heavily generic
type Svc = Service<any>;

export type ItemCounts = {
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
};

const LOCK_FIELDS = [
  'lockHolder',
  'lockRefId',
  'lockAcquiredAt',
  'lockOperation',
  'lockMigrationId',
  'heartbeatAt',
] as const;

type MarkAppliedOpts = {
  migrationId: string;
  refId: string;
  appliedBy: string;
  itemCounts: ItemCounts;
  autoRelease: boolean;
};

// Apply success. Updates _migrations to status='applied' AND clears lock,
// removes from inFlightIds, and (if autoRelease=false) appends to
// deploymentBlockedIds — atomically.
export const markApplied = async (svc: Svc, opts: MarkAppliedOpts): Promise<void> => {
  const now = new Date().toISOString();
  await svc.transaction
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB transaction callback is a heavily-generic union over user-supplied entities
    .write(({ migrations, migrationState }: any) => {
      const stateUpdate = migrationState
        .update({ id: MIGRATION_STATE_ID })
        .remove([...LOCK_FIELDS])
        .set({ updatedAt: now })
        .delete({ inFlightIds: [opts.migrationId] });

      const finalStateUpdate = opts.autoRelease
        ? stateUpdate.delete({ deploymentBlockedIds: [opts.migrationId] })
        : stateUpdate.add({ deploymentBlockedIds: [opts.migrationId] });

      return [
        migrations
          .update({ id: opts.migrationId })
          .set({
            status: 'applied',
            appliedAt: now,
            appliedBy: opts.appliedBy,
            itemCounts: opts.itemCounts,
          })
          .commit(),
        finalStateUpdate
          // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
          .where((attr: any, op: any) => op.eq(attr.lockRefId, opts.refId))
          .commit(),
      ];
    })
    .go();
};

type MarkFailedOpts = {
  migrationId: string;
  refId: string;
  itemCounts: ItemCounts;
  errorMessage: string;
};

// Apply failure. Updates _migrations to status='failed' AND adds id to
// failedIds, clears lock, removes from inFlightIds. Does NOT touch
// deploymentBlockedIds (that's an orthogonal flag).
export const markFailed = async (svc: Svc, opts: MarkFailedOpts): Promise<void> => {
  const now = new Date().toISOString();
  await svc.transaction
    // biome-ignore lint/suspicious/noExplicitAny: see markApplied
    .write(({ migrations, migrationState }: any) => [
      migrations
        .update({ id: opts.migrationId })
        .set({
          status: 'failed',
          error: opts.errorMessage,
          itemCounts: opts.itemCounts,
        })
        .commit(),
      migrationState
        .update({ id: MIGRATION_STATE_ID })
        .remove([...LOCK_FIELDS])
        .set({ updatedAt: now })
        .delete({ inFlightIds: [opts.migrationId] })
        .add({ failedIds: [opts.migrationId] })
        // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
        .where((attr: any, op: any) => op.eq(attr.lockRefId, opts.refId))
        .commit(),
    ])
    .go();
};

type MarkFinalizedOpts = {
  migrationId: string;
  refId: string;
};

// Finalize success. Updates _migrations to status='finalized' AND clears
// lock, removes from inFlightIds. Does NOT touch deploymentBlockedIds —
// finalize doesn't gate deploys (the deploy already happened during the
// bake window). Does NOT touch failedIds — a successful finalize wouldn't
// be possible if the migration was in failed state.
export const markFinalized = async (svc: Svc, opts: MarkFinalizedOpts): Promise<void> => {
  const now = new Date().toISOString();
  await svc.transaction
    // biome-ignore lint/suspicious/noExplicitAny: see markApplied
    .write(({ migrations, migrationState }: any) => [
      migrations
        .update({ id: opts.migrationId })
        .set({
          status: 'finalized',
          finalizedAt: now,
        })
        .commit(),
      migrationState
        .update({ id: MIGRATION_STATE_ID })
        .remove([...LOCK_FIELDS])
        .set({ updatedAt: now })
        .delete({ inFlightIds: [opts.migrationId] })
        // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
        .where((attr: any, op: any) => op.eq(attr.lockRefId, opts.refId))
        .commit(),
    ])
    .go();
};

type MarkRevertedOpts = {
  migrationId: string;
  refId: string;
  autoRelease: boolean;
};

// Rollback success. Updates _migrations to status='reverted' AND clears
// lock, removes from inFlightIds, removes from failedIds (rollback resolves
// failures), and either appends to or removes from deploymentBlockedIds based
// on autoRelease — atomically.
export const markReverted = async (svc: Svc, opts: MarkRevertedOpts): Promise<void> => {
  const now = new Date().toISOString();
  await svc.transaction
    // biome-ignore lint/suspicious/noExplicitAny: see markApplied
    .write(({ migrations, migrationState }: any) => {
      const stateUpdate = migrationState
        .update({ id: MIGRATION_STATE_ID })
        .remove([...LOCK_FIELDS])
        .set({ updatedAt: now })
        .delete({ inFlightIds: [opts.migrationId] })
        .delete({ failedIds: [opts.migrationId] });

      const finalStateUpdate = opts.autoRelease
        ? stateUpdate.delete({ deploymentBlockedIds: [opts.migrationId] })
        : stateUpdate.add({ deploymentBlockedIds: [opts.migrationId] });

      return [
        migrations
          .update({ id: opts.migrationId })
          .set({
            status: 'reverted',
            revertedAt: now,
          })
          .commit(),
        finalStateUpdate
          // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
          .where((attr: any, op: any) => op.eq(attr.lockRefId, opts.refId))
          .commit(),
      ];
    })
    .go();
};
