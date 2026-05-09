/**
 * WARNING 1 — Audit-row shape TS type-test.
 *
 * The rollback orchestrator maps `audit.reverted → itemCounts.migrated` when calling
 * `transitionToReleaseMode`. This is semantically deliberate:
 *
 *   apply:    itemCounts.migrated = records put as v2  (forward direction)
 *   rollback: itemCounts.migrated = records put as v1  (reverse direction = audit.reverted)
 *
 * This file pins the assignability of `RollbackItemCounts['reverted']` to
 * `transitionToReleaseMode`'s `itemCounts.migrated` field at compile time.
 * A future change to either shape produces a hard build error before the
 * orchestrator's mapping does.
 *
 * @see src/rollback/orchestrator.ts — the transitionToReleaseMode call site
 * @see src/rollback/audit.ts — RollbackItemCounts definition
 * @see src/state-mutations/transition.ts — TransitionArgs.itemCounts definition
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { RollbackItemCounts } from '../../../src/rollback/audit.js';
import type { transitionToReleaseMode } from '../../../src/state-mutations/index.js';

// Extract the `itemCounts.migrated` field type from `transitionToReleaseMode`'s
// second parameter without importing the implementation.
type TransitionArgs = Parameters<typeof transitionToReleaseMode>[1];
type TransitionItemCounts = NonNullable<TransitionArgs['itemCounts']>;
type MigratedField = TransitionItemCounts['migrated'];

describe('WARNING 1 — audit-row mapping type compatibility', () => {
  it('RollbackItemCounts.reverted is assignable to transitionToReleaseMode itemCounts.migrated', () => {
    // The orchestrator maps `audit.reverted → itemCounts.migrated`; if the types diverge,
    // this test produces a compile error before the orchestrator's mapping does.
    expectTypeOf<RollbackItemCounts['reverted']>().toEqualTypeOf<MigratedField>();
  });

  it('RollbackItemCounts contains the required fields (scanned, reverted, deleted, skipped, failed)', () => {
    expectTypeOf<RollbackItemCounts>().toHaveProperty('scanned').toBeNumber();
    expectTypeOf<RollbackItemCounts>().toHaveProperty('reverted').toBeNumber();
    expectTypeOf<RollbackItemCounts>().toHaveProperty('deleted').toBeNumber();
    expectTypeOf<RollbackItemCounts>().toHaveProperty('skipped').toBeNumber();
    expectTypeOf<RollbackItemCounts>().toHaveProperty('failed').toBeNumber();
  });
});
