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

  // ----- Refusal: finalized reads-target migration also blocks -----

  it('refuses when reads-target has a finalized later-version migration (status=finalized is blocking)', async () => {
    const stub = makeRollbackStubService();

    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    // Team migration that is finalized (not just applied) — still blocking
    const teamFinalized = makeRow({
      id: '20260601000007-Team-finalized',
      entityName: 'Team',
      status: 'finalized',
      fromVersion: '2',
      toVersion: '3',
    });

    stub.setScanPages(undefined, [targetRow, teamFinalized]);
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
      expect(err.details?.reason).toBe('READS_DEPENDENCY_APPLIED');
    }
  });

  // ----- Proceed: reverted reads-target migration is NOT blocking -----

  it('proceeds when reads-target has a reverted later-version migration (reverted is not blocking)', async () => {
    const stub = makeRollbackStubService();

    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    // Team migration was applied then reverted — no longer an active dependency
    const teamReverted = makeRow({
      id: '20260601000007-Team-reverted',
      entityName: 'Team',
      status: 'reverted',
      fromVersion: '2',
      toVersion: '3',
    });

    stub.setScanPages(undefined, [targetRow, teamReverted]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
  });

  // ----- Remediation message includes blocking migration id and 'first' -----

  it('error remediation mentions the blocking migration id and the word "first"', async () => {
    const stub = makeRollbackStubService();

    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    const blockingTeamId = '20260601000007-Team-add-tier';
    const teamRow = makeRow({
      id: blockingTeamId,
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
      const err = result.error as Error & { remediation?: string };
      expect(err.remediation).toContain(blockingTeamId);
      expect(err.remediation?.toLowerCase()).toContain('first');
    }
  });

  // ----- Earliest blocker is reported when multiple blockers exist -----

  it('reports the EARLIEST blocker (lowest fromVersion) when multiple reads-target migrations block', async () => {
    const stub = makeRollbackStubService();

    const targetRow = makeRow({
      id: MIG_ID,
      entityName: 'User',
      status: 'applied',
      fromVersion: '1',
      toVersion: '2',
      reads: new Set(['Team']),
    });

    // Two blocking Team migrations — fromVersion 3 and 2. Helper sorts ascending so fromVersion=2 is earliest.
    const teamLater4 = makeRow({
      id: '20260601000009-Team-v4',
      entityName: 'Team',
      status: 'applied',
      fromVersion: '3',
      toVersion: '4',
    });
    const teamLater3 = makeRow({
      id: '20260601000008-Team-v3',
      entityName: 'Team',
      status: 'applied',
      fromVersion: '2',
      toVersion: '3',
    });

    // Order in the scan is reversed (latest first) — helper sorts ascending by fromVersion.
    stub.setScanPages(undefined, [targetRow, teamLater4, teamLater3]);
    stub.setGetResult(makeFreeLockRow());

    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { details?: { blockingMigration?: string } };
      // The earliest blocker (fromVersion=2) is reported so the user fixes it first.
      expect(err.details?.blockingMigration).toBe('20260601000008-Team-v3');
    }
  });
});
