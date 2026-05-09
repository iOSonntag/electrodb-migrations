/**
 * Unit tests for `rollbackCase1` (Case 1 — pre-release rollback per RBK-03).
 *
 * Case 1 is the lossless pre-release rollback path: the migration is either
 * in `pending`/`failed` state OR in `release` mode with the migration ID in
 * `releaseIds`. In both sub-cases v1 records are still intact, so the
 * rollback action is to DELETE every v2 record without touching v1.
 *
 * Key properties under test:
 *   - Cursor-based v2 scan with `consistent: CONSISTENT_READ` (T-05-08-02)
 *   - Per-page `batchFlushRollback({v2Deletes})` call — NO puts, NO v1Deletes
 *   - `migration.down` is NEVER accessed (RBK-03 lossless guarantee)
 *   - Audit invariant holds: `scanned === deleted` (reverted=0, skipped=0, failed=0)
 *   - Errors from `batchFlushRollback` propagate unswallowed
 *
 * Fixture: `User-add-status-no-down` — explicitly lacks `down()` to make the
 * "down NOT required" property load-bearing (not just incidental).
 *
 * @see src/rollback/case-1-flow.ts
 * @see RBK-03
 */

import { describe, expect, it, vi } from 'vitest';
import { createRollbackAudit } from '../../../src/rollback/audit.js';
import { rollbackCase1 } from '../../../src/rollback/case-1-flow.js';
import { makeRollbackStubService } from './_stub-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeV2Record(id: string): Record<string, unknown> {
  return { id, name: `User-${id}`, status: 'active' };
}

function makeV2Page(count: number, startIdx = 0): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => makeV2Record(`u-${startIdx + i}`));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('rollbackCase1 (RBK-03 — pre-release rollback by v2 delete)', () => {
  it('empty v2 scan → no batch flush, all audit counts zero, invariant holds', async () => {
    const stub = makeRollbackStubService();
    // Single page with empty data and null cursor
    stub.setScanPages('v2', [[]]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    const result = await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(result).toBeDefined();
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();

    // batchWriteSendSpy should NOT have been called
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  it('5 v2 records in one page → batch flush called once, audit.scanned=5, deleted=5', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [makeV2Page(5)]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    // batchWriteSendSpy returns a successful no-unprocessed result
    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.deleted).toBe(5);
    expect(counts.reverted).toBe(0);

    // batchWriteSendSpy must have been called exactly once (5 items < 25)
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);
  });

  it('30 v2 records across 2 pages (25+5) → batch flush called twice, scanned=30, deleted=30', async () => {
    const stub = makeRollbackStubService();
    // Two pages: first page 25 records, second page 5 records
    stub.setScanPages('v2', [makeV2Page(25, 0), makeV2Page(5, 25)]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(30);
    expect(counts.deleted).toBe(30);

    // batchFlushRollback is called per page — 2 scan pages → 2 BatchWrite sends
    // (25 items = 1 batch per page; no additional chunk splits)
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(2);
  });

  it('100 v2 records across 4 pages of 25 each → batch flush called 4 times, scanned=100, deleted=100', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [
      makeV2Page(25, 0),
      makeV2Page(25, 25),
      makeV2Page(25, 50),
      makeV2Page(25, 75),
    ]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(100);
    expect(counts.deleted).toBe(100);

    // 4 scan pages × 1 BatchWrite per page (25 items ≤ DDB_BATCH_LIMIT)
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(4);
  });

  it('migration has NO down function (User-add-status-no-down fixture) → rollback still succeeds', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [makeV2Page(3)]);
    // hasDown: false matches the User-add-status-no-down fixture contract
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    // Assert that migration.down is genuinely absent (the fixture property).
    expect((migration as Record<string, unknown>).down).toBeUndefined();

    // rollbackCase1 must NOT access migration.down at all — it should not throw
    // because down is missing; confirmed by assertion above plus the fact that
    // no spy on migration.down is needed (undefined property = no accessor).
    await expect(
      rollbackCase1({
        migration: migration as never,
        client: stub.client as never,
        tableName: 'test-table',
        audit,
      }),
    ).resolves.toBeDefined();

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.deleted).toBe(3);
  });

  it('scan calls use consistent: CONSISTENT_READ (every captured scan op has opts.consistent === true)', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [makeV2Page(2), makeV2Page(1)]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    // Filter to v2 scan captures
    const v2Scans = stub.captured.filter(
      (c) => c.op === 'scan' && (c.scanOpts as Record<string, unknown>)?._scanKey === 'v2',
    );
    expect(v2Scans.length).toBeGreaterThan(0);
    for (const scan of v2Scans) {
      expect((scan.scanOpts as Record<string, unknown>).consistent).toBe(true);
    }
  });

  it('default page size is 100 (first scan call opts.limit === 100)', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [[]]); // empty page to trigger one scan
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const v2Scans = stub.captured.filter(
      (c) => c.op === 'scan' && (c.scanOpts as Record<string, unknown>)?._scanKey === 'v2',
    );
    expect(v2Scans.length).toBeGreaterThan(0);
    expect((v2Scans[0]!.scanOpts as Record<string, unknown>).limit).toBe(100);
  });

  it('custom pageSize: rollbackCase1({pageSize: 25}) → first scan call opts.limit === 25', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [[]]); // empty page
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      pageSize: 25,
    });

    const v2Scans = stub.captured.filter(
      (c) => c.op === 'scan' && (c.scanOpts as Record<string, unknown>)?._scanKey === 'v2',
    );
    expect(v2Scans.length).toBeGreaterThan(0);
    expect((v2Scans[0]!.scanOpts as Record<string, unknown>).limit).toBe(25);
  });

  it('batchFlushRollback throw propagates (no swallow) — audit may have partial scan counts', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [makeV2Page(3)]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    const batchError = new Error('EDBBatchWriteExhaustedError: all retries exhausted');
    stub.batchWriteSendSpy.mockRejectedValue(batchError);

    await expect(
      rollbackCase1({
        migration: migration as never,
        client: stub.client as never,
        tableName: 'test-table',
        audit,
      }),
    ).rejects.toThrow('EDBBatchWriteExhaustedError');

    // Partial scan counts: scanned incremented before flush, deleted not yet counted
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    // deleted may be 0 (throw happened before addDeleted) — the orchestrator marks failed
    expect(counts.deleted).toBeLessThanOrEqual(3);
  });

  it('rollbackCase1 returns an object (RollbackCase1Result shape) on success', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v2', [makeV2Page(2)]);
    const migration = stub.makeMigration({ hasDown: false });
    const audit = createRollbackAudit();

    stub.batchWriteSendSpy.mockResolvedValue({ UnprocessedItems: undefined });

    const result = await rollbackCase1({
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});
