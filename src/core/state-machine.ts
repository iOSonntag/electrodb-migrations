import type { MigrationStatus } from '../types.js';

// Pure decision functions consumed by apply/finalize/rollback.
// Kept structurally separate from the I/O layer so the lifecycle rules can be
// audited and tested without touching DDB.

export type ApplyDecision =
  | { kind: 'proceed' }
  | { kind: 'skip'; reason: 'already-applied' | 'already-finalized' }
  | { kind: 'requires-rollback'; status: MigrationStatus };

export type FinalizeDecision =
  | { kind: 'proceed' }
  | { kind: 'skip'; reason: 'already-finalized' }
  | { kind: 'invalid-state'; status: MigrationStatus | undefined };

export type RollbackDecision =
  | { kind: 'pre-finalize' }
  | { kind: 'post-finalize' }
  | { kind: 'no-op'; reason: 'no-row' | 'pending' }
  | { kind: 'already-reverted' };

export const decideApply = (current: MigrationStatus | undefined): ApplyDecision => {
  if (current === undefined || current === 'pending') return { kind: 'proceed' };
  if (current === 'applied') return { kind: 'skip', reason: 'already-applied' };
  if (current === 'finalized') return { kind: 'skip', reason: 'already-finalized' };
  // failed | reverted — caller must rollback (or, for reverted, M3's --force) first.
  return { kind: 'requires-rollback', status: current };
};

export const decideFinalize = (current: MigrationStatus | undefined): FinalizeDecision => {
  if (current === 'applied') return { kind: 'proceed' };
  if (current === 'finalized') return { kind: 'skip', reason: 'already-finalized' };
  return { kind: 'invalid-state', status: current };
};

export const decideRollback = (current: MigrationStatus | undefined): RollbackDecision => {
  if (current === undefined) return { kind: 'no-op', reason: 'no-row' };
  if (current === 'pending') return { kind: 'no-op', reason: 'pending' };
  if (current === 'applied' || current === 'failed') return { kind: 'pre-finalize' };
  if (current === 'finalized') return { kind: 'post-finalize' };
  return { kind: 'already-reverted' };
};
