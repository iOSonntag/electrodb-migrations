/**
 * Unit tests for `executeProjected` — the default rollback strategy (RBK-05).
 *
 * Per-type dispatch table (RESEARCH §Section 4 lines 1180-1186):
 * | Type | Action                              | Audit increment         |
 * |------|-------------------------------------|-------------------------|
 * | A    | v1Derived = await down(v2) → put    | addReverted(1) after flush |
 * | B    | v1Derived = await down(v2) → put    | addReverted(1) after flush |
 * | C    | v1Deletes.push(entry.v1Original!)   | addDeleted(1) after flush  |
 *
 * Tests use `makeRollbackStubService()` to inject the classifier via a
 * hand-rolled async generator that yields canned TypeTableEntry values.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeProjected } from '../../../../src/rollback/strategies/projected.js';
import { createRollbackAudit } from '../../../../src/rollback/audit.js';
import { makeRollbackStubService } from '../_stub-service.js';
import type { TypeTableEntry } from '../../../../src/rollback/type-table.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function* makeClassifier(entries: TypeTableEntry[]): AsyncGenerator<TypeTableEntry> {
  for (const entry of entries) {
    yield entry;
  }
}

function makeTypeA(id: string): TypeTableEntry {
  return {
    type: 'A',
    domainKey: `id=${id}`,
    v1Original: { id, name: `Alice-${id}` },
    v2: { id, name: `Alice-${id}`, status: 'active' },
  };
}

function makeTypeB(id: string): TypeTableEntry {
  return {
    type: 'B',
    domainKey: `id=${id}`,
    v2: { id, name: `Bob-${id}`, status: 'active' },
  };
}

function makeTypeC(id: string): TypeTableEntry {
  return {
    type: 'C',
    domainKey: `id=${id}`,
    v1Original: { id, name: `Carol-${id}` },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeProjected', () => {
  it('empty classifier → batch flush called with empty puts+v1Deletes; audit 0s; invariant holds', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    await executeProjected({
      classify: makeClassifier([]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('5 type A → 5 down() calls; 1 batch flush; reverted=5, scanned=5, deleted=0, skipped=0', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const downSpy = vi.fn(async (record: unknown) => {
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries = [1, 2, 3, 4, 5].map((i) => makeTypeA(`u-${i}`));

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(downSpy.mock.calls).toHaveLength(5);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.reverted).toBe(5);
    expect(counts.deleted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('3 type A + 2 type B → 5 down() calls; 1 batch flush; reverted=5, deleted=0', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const downSpy = vi.fn(async (record: unknown) => {
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries: TypeTableEntry[] = [
      makeTypeA('u-1'),
      makeTypeA('u-2'),
      makeTypeA('u-3'),
      makeTypeB('u-4'),
      makeTypeB('u-5'),
    ];

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(downSpy.mock.calls).toHaveLength(5);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.reverted).toBe(5);
    expect(counts.deleted).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('3 type C → 0 down() calls; 1 batch flush; reverted=0, deleted=3', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const downSpy = vi.fn();
    (migration as Record<string, unknown>).down = downSpy;

    const entries = [1, 2, 3].map((i) => makeTypeC(`u-${i}`));

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(downSpy.mock.calls).toHaveLength(0);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(3);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('2A + 1B + 2C → 3 down() calls; batch flush with 3 puts + 2 v1Deletes; reverted=3, deleted=2', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const downSpy = vi.fn(async (record: unknown) => {
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries: TypeTableEntry[] = [
      makeTypeA('u-1'),
      makeTypeA('u-2'),
      makeTypeB('u-3'),
      makeTypeC('u-4'),
      makeTypeC('u-5'),
    ];

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(downSpy.mock.calls).toHaveLength(3);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.reverted).toBe(3);
    expect(counts.deleted).toBe(2);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('down() throws on 3rd record → audit.failed=1, audit.scanned=3, batch flush NOT called, error rethrows', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    let callCount = 0;
    const downSpy = vi.fn(async (record: unknown) => {
      callCount++;
      if (callCount === 3) {
        throw new Error('down failed on record 3');
      }
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries = [1, 2, 3, 4, 5].map((i) => makeTypeA(`u-${i}`));

    await expect(
      executeProjected({
        classify: makeClassifier(entries),
        migration: migration as never,
        client: stub.client as never,
        tableName: 'test-table',
        audit,
      }),
    ).rejects.toThrow('down failed on record 3');

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.failed).toBe(1);
    // Batch flush was NOT called (throw mid-loop before flush)
    const batchCalls = stub.captured.filter((c) => c.op === 'batch-write');
    expect(batchCalls).toHaveLength(0);
  });

  it('down() returns null on a type A → audit.skipped=1; batch flush runs with remaining records', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    let callCount = 0;
    const downSpy = vi.fn(async (record: unknown) => {
      callCount++;
      if (callCount === 2) {
        return null; // OQ-2 mirror: down returning null → skip
      }
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries = [1, 2, 3].map((i) => makeTypeA(`u-${i}`));

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.skipped).toBe(1);
    // reverted = 2 (records 1 and 3), not 3
    expect(counts.reverted).toBe(2);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('down() is invoked with the v2 record VERBATIM (first-arg matches entry.v2)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const capturedArgs: unknown[] = [];
    const downSpy = vi.fn(async (record: unknown) => {
      capturedArgs.push(record);
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entry = makeTypeA('u-specific');

    await executeProjected({
      classify: makeClassifier([entry]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toEqual(entry.v2);
  });

  it('type C entries accumulate as v1Deletes (audit.deleted set; not in puts)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();

    const entries: TypeTableEntry[] = [
      makeTypeC('u-del-1'),
      makeTypeC('u-del-2'),
    ];

    await executeProjected({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
    });

    const counts = audit.snapshot();
    expect(counts.deleted).toBe(2);
    expect(counts.reverted).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });
});
