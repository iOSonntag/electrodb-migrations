/**
 * Unit tests for `checkPreconditions` CTX-08 extension — Step 10 addition.
 *
 * RED phase: written before the implementation and expected to FAIL at runtime
 * because Plan 06-05 has not yet added Step 10 to `checkPreconditions`.
 * The import of `checkPreconditions` SUCCEEDS (the function exists from Phase 5)
 * but the tests fail because the READS_DEPENDENCY_APPLIED case is not yet handled.
 *
 * CTX-08: rollback refused if any migration on a `reads` target has been applied
 * since M. A migration on reads-target entity Y that has status=applied|finalized
 * and whose fromVersion is >= M's toVersion means Y was migrated to a newer shape
 * after M was authored — M's rollback is blocked.
 *
 * Plan 06-05 adds Step 10 to checkPreconditions and adds READS_DEPENDENCY_APPLIED
 * to ROLLBACK_REASON_CODES. These tests then flip from RED (no CTX-08 logic)
 * to GREEN.
 *
 * RESEARCH §OQ7, §Pattern 3, §Pitfall 6 (use sequence ordering not timestamps).
 */
import { describe, expect, it } from 'vitest';
import { makeRollbackStubService } from './_stub-service.js';
import { checkPreconditions } from '../../../src/rollback/preconditions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `_migrations` row for injection into the stub service's scan
 * queue. Extends the base `makeRow` from preconditions.test.ts with an optional
 * `reads` field (Set<string>) needed for CTX-08 tests.
 *
 * Duplicated here rather than cross-imported — test files should not import
 * each other per project convention.
 */
function makeRow(overrides: {
  id: string;
  entityName?: string;
  status: 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';
  toVersion?: string;
  fromVersion?: string;
  reads?: Set<string>;
}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: overrides.id,
    entityName: overrides.entityName ?? 'User',
    status: overrides.status,
    toVersion: overrides.toVersion ?? '2',
    fromVersion: overrides.fromVersion ?? '1',
  };
  if (overrides.reads !== undefined) {
    row.reads = overrides.reads;
  }
  return row;
}

/** Default lock row in "free" state (no active lock). */
function makeFreeLockRow(): { data: Record<string, unknown> | null } {
  return { data: null };
}

/** Migration id used in most tests. */
const MIG_ID = '20260601000005-User-reads-Team';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkPreconditions CTX-08: reads dependency applied', () => {
  // ----- Refusal: reads-target has a later-applied migration -----

  it('refuses with READS_DEPENDENCY_APPLIED when a reads-target has a later-applied migration', async () => {
    const stub = makeRollbackStubService();

    // M (User v1→v2) declares reads: {'Team'} and toVersion='2'
    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    // A Team migration that moves from v2 (>= M's toVersion=2) — blocking
    const teamRow = makeRow({
      id: '20260601000007-Team-add-tier',
      entityName: 'Team',
      status: 'applied',
      fromVersion: '2',
      toVersion: '3',
    });

    stub.setScanPages(undefined, [targetRow, teamRow]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('READS_DEPENDENCY_APPLIED');
    }
  });

  // ----- Proceed: reads is empty/undefined -----

  it('proceeds when target has no reads declaration (reads is undefined)', async () => {
    const stub = makeRollbackStubService();

    // M has no reads field at all
    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
    });

    stub.setScanPages(undefined, [targetRow]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
  });

  // ----- Proceed: reads-target has only earlier-version migrations -----

  it('proceeds when reads-target has only earlier-version migrations (fromVersion < M.toVersion)', async () => {
    const stub = makeRollbackStubService();

    // M (User v1→v2) declares reads: {'Team'} and toVersion='2'
    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    // A Team migration that is EARLIER (fromVersion='0' → toVersion='1'):
    // Its toVersion=1 < M's toVersion=2 — not blocking
    const teamRow = makeRow({
      id: '20260101000001-Team-initial',
      entityName: 'Team',
      status: 'applied',
      fromVersion: '0',
      toVersion: '1',
    });

    stub.setScanPages(undefined, [targetRow, teamRow]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
  });

  // ----- Literal READS_DEPENDENCY_APPLIED string -----

  it('READS_DEPENDENCY_APPLIED is the exact reason code literal returned in the error details', async () => {
    const stub = makeRollbackStubService();

    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    const teamRow = makeRow({
      id: '20260601000007-Team-add-tier',
      entityName: 'Team',
      status: 'applied',
      fromVersion: '2',
      toVersion: '3',
    });

    stub.setScanPages(undefined, [targetRow, teamRow]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { details?: { reason?: string } };
      // Assert the EXACT string — Plan 06-05 adds this key to ROLLBACK_REASON_CODES.
      expect(err.details?.reason).toBe('READS_DEPENDENCY_APPLIED');
    }
  });
});
