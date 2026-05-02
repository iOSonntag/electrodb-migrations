import { describe, expect, it } from 'vitest';
import { decideApply, decideFinalize, decideRollback } from '../../src/core/state-machine.js';

describe('decideApply', () => {
  it('proceeds when no row exists yet', () => {
    expect(decideApply(undefined)).toEqual({ kind: 'proceed' });
  });

  it('proceeds on pending', () => {
    expect(decideApply('pending')).toEqual({ kind: 'proceed' });
  });

  it('skips on applied (idempotent re-apply)', () => {
    expect(decideApply('applied')).toEqual({ kind: 'skip', reason: 'already-applied' });
  });

  it('skips on finalized (idempotent re-apply)', () => {
    expect(decideApply('finalized')).toEqual({ kind: 'skip', reason: 'already-finalized' });
  });

  it('requires rollback on failed', () => {
    expect(decideApply('failed')).toEqual({ kind: 'requires-rollback', status: 'failed' });
  });

  it('requires rollback on reverted (terminal)', () => {
    expect(decideApply('reverted')).toEqual({ kind: 'requires-rollback', status: 'reverted' });
  });
});

describe('decideFinalize', () => {
  it('rejects when no row exists yet', () => {
    expect(decideFinalize(undefined)).toEqual({ kind: 'invalid-state', status: undefined });
  });

  it('rejects on pending', () => {
    expect(decideFinalize('pending')).toEqual({ kind: 'invalid-state', status: 'pending' });
  });

  it('proceeds on applied', () => {
    expect(decideFinalize('applied')).toEqual({ kind: 'proceed' });
  });

  it('rejects on failed', () => {
    expect(decideFinalize('failed')).toEqual({ kind: 'invalid-state', status: 'failed' });
  });

  it('skips on finalized (idempotent)', () => {
    expect(decideFinalize('finalized')).toEqual({ kind: 'skip', reason: 'already-finalized' });
  });

  it('rejects on reverted', () => {
    expect(decideFinalize('reverted')).toEqual({ kind: 'invalid-state', status: 'reverted' });
  });
});

describe('decideRollback', () => {
  it('no-op when no row exists yet', () => {
    expect(decideRollback(undefined)).toEqual({ kind: 'no-op', reason: 'no-row' });
  });

  it('no-op on pending (no v2 records to clean up)', () => {
    expect(decideRollback('pending')).toEqual({ kind: 'no-op', reason: 'pending' });
  });

  it('pre-finalize rollback from applied', () => {
    expect(decideRollback('applied')).toEqual({ kind: 'pre-finalize' });
  });

  it('pre-finalize rollback from failed', () => {
    expect(decideRollback('failed')).toEqual({ kind: 'pre-finalize' });
  });

  it('post-finalize rollback from finalized', () => {
    expect(decideRollback('finalized')).toEqual({ kind: 'post-finalize' });
  });

  it('rejects already-reverted', () => {
    expect(decideRollback('reverted')).toEqual({ kind: 'already-reverted' });
  });
});
