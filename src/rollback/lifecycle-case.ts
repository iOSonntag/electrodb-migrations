/**
 * `determineLifecycleCase` — maps a `_migrations` row's status + the current
 * lock row into a lifecycle case used by the rollback strategy dispatcher.
 *
 * RESEARCH §Section 1, lines 1024-1027 (lifecycle×strategy truth table):
 *
 *   Case 1 (pre-release): status ∈ {pending, failed}
 *     OR (status='applied' AND lockState='release' AND releaseIds.has(migId))
 *   Case 2 (post-release, pre-finalize): status='applied' AND NOT Case 1
 *   Case 3 (post-finalize): status='finalized'
 *
 * This is a pure function (no I/O). `checkPreconditions` calls it AFTER
 * filtering already-reverted and pending statuses — so by the time this
 * function is called in production, `status` is one of: 'applied' | 'finalized'
 * | 'failed'. The 'pending' and 'reverted' branches exist for defensive
 * robustness (tests pin the 'reverted' throw; 'pending' is still handled
 * correctly even though preconditions filters it first).
 *
 * RBK-01 / RBK-09 / RBK-10.
 */
export function determineLifecycleCase(
  migrationsRow: { status: string },
  lockRow: { lockState: string; releaseIds?: ReadonlySet<string> } | null,
  migId: string,
): 'case-1' | 'case-2' | 'case-3' {
  // Case 1a: failed or pending — always pre-release.
  if (migrationsRow.status === 'failed' || migrationsRow.status === 'pending') {
    return 'case-1';
  }

  if (migrationsRow.status === 'applied') {
    // Case 1b: success-path pre-release — applied AND currently in release mode for THIS mig.
    if (isReleaseModeForMig(lockRow, migId)) {
      return 'case-1';
    }
    // Case 2: post-release, pre-finalize.
    return 'case-2';
  }

  if (migrationsRow.status === 'finalized') {
    return 'case-3';
  }

  // 'reverted' should be filtered upstream by checkPreconditions. Throw
  // defensively so any code path that reaches here with a reverted row is
  // caught early (pins the invariant in tests).
  throw new Error(`Unexpected _migrations.status: ${migrationsRow.status}`);
}

/**
 * Returns true iff the lock row indicates the given migration is currently
 * in the success-path pre-release window:
 *   lockState='release' AND releaseIds contains migId.
 *
 * Used exclusively by `determineLifecycleCase` to detect Case 1 from an
 * otherwise-applied status row.
 */
function isReleaseModeForMig(
  lockRow: { lockState: string; releaseIds?: ReadonlySet<string> } | null,
  migId: string,
): boolean {
  return lockRow?.lockState === 'release' && (lockRow.releaseIds?.has(migId) ?? false);
}
