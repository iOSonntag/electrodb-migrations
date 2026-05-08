import { describe, expect, it } from 'vitest';
import { type CancellationReason, extractCancellationReason, isConditionalCheckFailed } from '../../../src/state-mutations/cancellation.js';

/**
 * Pitfall #7 — every state-mutations verb places `_migration_state` at item 0
 * of its transactWrite. The cancellation helpers therefore inspect index 0
 * for the lock-row diagnosis. Tests here pin that contract.
 */

describe('isConditionalCheckFailed (Pitfall #7 item-0 attribution)', () => {
  it('returns true when the error is a TransactionCanceledException whose item-0 reason is ConditionalCheckFailed', () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    };
    expect(isConditionalCheckFailed(err)).toBe(true);
  });

  it('returns true even when later items have other codes — only item 0 matters', () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed', Item: { lockState: 'apply', lockHolder: 'host-A' } }, { Code: 'None' }],
    };
    expect(isConditionalCheckFailed(err)).toBe(true);
  });

  it('returns false when item 0 is not ConditionalCheckFailed (e.g. only item 1 cancelled)', () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    };
    expect(isConditionalCheckFailed(err)).toBe(false);
  });

  it('returns false when CancellationReasons is missing', () => {
    expect(isConditionalCheckFailed({ name: 'TransactionCanceledException' })).toBe(false);
  });

  it('returns false when CancellationReasons is empty', () => {
    expect(isConditionalCheckFailed({ name: 'TransactionCanceledException', CancellationReasons: [] })).toBe(false);
  });

  it('returns false for a generic Error', () => {
    expect(isConditionalCheckFailed(new Error('Some other failure'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isConditionalCheckFailed(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isConditionalCheckFailed(undefined)).toBe(false);
  });

  it('returns false for non-objects (string, number)', () => {
    expect(isConditionalCheckFailed('TransactionCanceledException')).toBe(false);
    expect(isConditionalCheckFailed(42)).toBe(false);
  });

  it('does NOT regex on err.message — message-only matches must return false', () => {
    const err = new Error('TransactionCanceledException: ConditionalCheckFailed');
    expect(isConditionalCheckFailed(err)).toBe(false);
  });
});

describe('extractCancellationReason', () => {
  it('returns item-0 details with index, code, and item when ALL_OLD is present', () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        {
          Code: 'ConditionalCheckFailed',
          Item: { lockState: 'apply', lockHolder: 'other-host', lockRunId: 'other-run' },
        },
        { Code: 'None' },
      ],
    };
    const reason = extractCancellationReason(err);
    expect(reason).toEqual<CancellationReason>({
      index: 0,
      code: 'ConditionalCheckFailed',
      item: { lockState: 'apply', lockHolder: 'other-host', lockRunId: 'other-run' },
    });
  });

  it('returns item-0 details with item undefined when DDB Local omits ALL_OLD', () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    };
    const reason = extractCancellationReason(err);
    expect(reason).not.toBeNull();
    expect(reason?.index).toBe(0);
    expect(reason?.code).toBe('ConditionalCheckFailed');
    expect(reason?.item).toBeUndefined();
  });

  it('returns null when CancellationReasons is missing', () => {
    expect(extractCancellationReason(new Error('boom'))).toBeNull();
  });

  it('returns null for a non-object error', () => {
    expect(extractCancellationReason('boom')).toBeNull();
    expect(extractCancellationReason(null)).toBeNull();
  });

  it('returns null when CancellationReasons is empty', () => {
    expect(
      extractCancellationReason({
        name: 'TransactionCanceledException',
        CancellationReasons: [],
      }),
    ).toBeNull();
  });

  it("falls back to 'Unknown' when item-0 has no Code field", () => {
    const err = {
      name: 'TransactionCanceledException',
      CancellationReasons: [{}],
    };
    const reason = extractCancellationReason(err);
    expect(reason?.code).toBe('Unknown');
    expect(reason?.index).toBe(0);
  });
});
