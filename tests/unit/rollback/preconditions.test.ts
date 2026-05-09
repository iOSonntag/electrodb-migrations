/**
 * Unit tests for `checkPreconditions` — truth-table coverage of every
 * refusal cell + every proceed cell (RBK-01/09/10).
 *
 * RED phase: written before the implementation and expected to FAIL.
 *
 * RESEARCH §Section 6, lines 1301-1316 (refusal truth table):
 *   EDB_MIGRATION_NOT_FOUND, EDB_ALREADY_REVERTED, EDB_NOT_APPLIED,
 *   EDB_ROLLBACK_OUT_OF_ORDER, NO_DOWN_FUNCTION, NO_RESOLVER,
 *   FINALIZED_ONLY_PROJECTED.
 */
import { describe, expect, it } from 'vitest';
import { makeRollbackStubService } from './_stub-service.js';
import { checkPreconditions } from '../../../src/rollback/preconditions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `_migrations` row for injection into the stub service's scan queue.
 * Fields mirror the subset `checkPreconditions` reads.
 */
function makeRow(overrides: {
  id: string;
  entityName?: string;
  status: 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';
  toVersion?: string;
  fromVersion?: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    entityName: overrides.entityName ?? 'User',
    status: overrides.status,
    toVersion: overrides.toVersion ?? '2',
    fromVersion: overrides.fromVersion ?? '1',
  };
}

/**
 * Build a minimal lock row for injection via `stub.setGetResult`.
 */
function makeLockRow(lockState: string, releaseIds?: ReadonlySet<string>): {
  data: Record<string, unknown>;
} {
  const row: Record<string, unknown> = {
    id: 'state',
    lockState,
    schemaVersion: 1,
    updatedAt: '2026-01-01T00:00:00Z',
  };
  if (releaseIds !== undefined) {
    row.releaseIds = releaseIds;
  }
  return { data: row };
}

/** Default migration id used in most tests */
const MIG_ID = '20260601000001';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkPreconditions', () => {
  // ----- Refusal: migration not found -----

  it('refuses with EDB_MIGRATION_NOT_FOUND when migration id is absent from _migrations table', async () => {
    const stub = makeRollbackStubService();
    // Empty scan: no rows in the table.
    stub.setScanPages(undefined, []);
    const migration = { ...stub.makeMigration(), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect((result.error as Error & { code?: string }).code).toBe('EDB_MIGRATION_NOT_FOUND');
    }
  });

  // ----- Refusal: already reverted -----

  it("refuses with EDB_ALREADY_REVERTED when target status='reverted'", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'reverted' })]);
    const migration = { ...stub.makeMigration(), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect((result.error as Error & { code?: string }).code).toBe('EDB_ALREADY_REVERTED');
    }
  });

  // ----- Refusal: not applied (pending) -----

  it("refuses with EDB_NOT_APPLIED when target status='pending'", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'pending' })]);
    const migration = { ...stub.makeMigration(), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect((result.error as Error & { code?: string }).code).toBe('EDB_NOT_APPLIED');
    }
  });

  // ----- Refusal: head violation (RBK-01) -----

  it('refuses with EDB_ROLLBACK_OUT_OF_ORDER when a newer applied migration exists for same entity', async () => {
    const stub = makeRollbackStubService();
    const target = makeRow({ id: MIG_ID, entityName: 'User', status: 'applied', toVersion: '2' });
    const newer = makeRow({ id: 'mig-v3', entityName: 'User', status: 'applied', toVersion: '3' });
    stub.setScanPages(undefined, [target, newer]);
    stub.setGetResult({ data: null }); // lock row: free
    const migration = { ...stub.makeMigration(), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect(result.error.constructor.name).toBe('EDBRollbackOutOfOrderError');
      const err = result.error as Error & { code?: string; details?: { offending?: string; entity?: string; target?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_OUT_OF_ORDER');
      expect(err.details?.offending).toBe('mig-v3');
      expect(err.details?.entity).toBe('User');
      expect(err.details?.target).toBe(MIG_ID);
    }
  });

  // ----- Proceed: case-2 + projected + hasDown -----

  it("proceeds (case-2) for status='applied' + strategy='projected' + migration has down()", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null }); // lock row: null (case-2)
    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-2');
      expect(result.targetRow.id).toBe(MIG_ID);
    }
  });

  // ----- Refusal: case-2 + projected + !hasDown -----

  it("refuses (NO_DOWN_FUNCTION) for status='applied' + strategy='projected' + no down()", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('NO_DOWN_FUNCTION');
    }
  });

  // ----- Proceed: case-2 + snapshot + !hasDown (snapshot doesn't require down) -----

  it("proceeds (case-2) for strategy='snapshot' even when migration has no down()", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'snapshot',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-2');
    }
  });

  // ----- Refusal: case-2 + fill-only + !hasDown -----

  it("refuses (NO_DOWN_FUNCTION) for strategy='fill-only' + no down()", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'fill-only',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('NO_DOWN_FUNCTION');
    }
  });

  // ----- Refusal: case-2 + custom + !rollbackResolver -----

  it("refuses (NO_RESOLVER) for strategy='custom' + no rollbackResolver", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false, hasRollbackResolver: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'custom',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('NO_RESOLVER');
    }
  });

  // ----- Proceed: case-2 + custom + hasResolver -----

  it("proceeds (case-2) for strategy='custom' + migration has rollbackResolver", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false, hasRollbackResolver: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'custom',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-2');
    }
  });

  // ----- Proceed: case-3 + projected + hasDown -----

  it("proceeds (case-3) for status='finalized' + strategy='projected' + hasDown", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-3');
    }
  });

  // ----- Refusal: case-3 + projected + !hasDown -----

  it("refuses (NO_DOWN_FUNCTION) for status='finalized' + strategy='projected' + no down()", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('NO_DOWN_FUNCTION');
    }
  });

  // ----- Refusal: case-3 + snapshot (regardless of hasDown) -----

  it("refuses (FINALIZED_ONLY_PROJECTED) for status='finalized' + strategy='snapshot'", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'snapshot',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('FINALIZED_ONLY_PROJECTED');
    }
  });

  // ----- Refusal: case-3 + fill-only -----

  it("refuses (FINALIZED_ONLY_PROJECTED) for status='finalized' + strategy='fill-only'", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'fill-only',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('FINALIZED_ONLY_PROJECTED');
    }
  });

  // ----- Proceed: case-3 + custom + hasResolver -----

  it("proceeds (case-3) for status='finalized' + strategy='custom' + hasResolver", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false, hasRollbackResolver: true }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'custom',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-3');
    }
  });

  // ----- Refusal: case-3 + custom + !rollbackResolver -----

  it("refuses (NO_RESOLVER) for status='finalized' + strategy='custom' + no rollbackResolver", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'finalized' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false, hasRollbackResolver: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'custom',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      const err = result.error as Error & { code?: string; details?: { reason?: string } };
      expect(err.code).toBe('EDB_ROLLBACK_NOT_POSSIBLE');
      expect(err.details?.reason).toBe('NO_RESOLVER');
    }
  });

  // ----- Proceed: case-1 (status='failed') + projected -----

  it("proceeds (case-1) for status='failed' + strategy='projected' (Case 1 ignores strategy/down)", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'failed' })]);
    stub.setGetResult(makeLockRow('failed'));
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-1');
    }
  });

  // ----- Proceed: case-1 success-path (status='applied', lockState='release', releaseIds) -----

  it("proceeds (case-1) for status='applied', lockState='release', releaseIds.has(migId) + strategy='snapshot'", async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult(makeLockRow('release', new Set([MIG_ID])));
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'snapshot',
    });

    expect(result.kind).toBe('proceed');
    if (result.kind === 'proceed') {
      expect(result.case).toBe('case-1');
    }
  });

  // ----- Verify remediation field is attached on refusal errors -----

  it('attaches a remediation field to EDB_MIGRATION_NOT_FOUND error', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, []);
    const migration = { ...stub.makeMigration(), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect((result.error as Error & { remediation?: string }).remediation).toBeTruthy();
    }
  });

  it('attaches a remediation field to EDB_ROLLBACK_NOT_POSSIBLE (NO_DOWN_FUNCTION) error', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages(undefined, [makeRow({ id: MIG_ID, status: 'applied' })]);
    stub.setGetResult({ data: null });
    const migration = { ...stub.makeMigration({ hasDown: false }), id: MIG_ID };

    const result = await checkPreconditions({
      service: stub.service as never,
      migration: migration as never,
      strategy: 'projected',
    });

    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') {
      expect((result.error as Error & { remediation?: string }).remediation).toBeTruthy();
    }
  });
});
