/**
 * Unit tests for `executeFillOnly` — the fill-only rollback strategy (RBK-07).
 *
 * Per-type dispatch table (RESEARCH §Section 4 lines 1200-1207):
 * | Type | Action                              | Audit increment       |
 * |------|-------------------------------------|-----------------------|
 * | A    | KEEP — no DDB write                 | incrementSkipped()    |
 * | B    | v1Derived = await down(v2) → put v1 | addReverted(1) after flush |
 * | C    | KEEP — no DDB write                 | incrementSkipped()    |
 *
 * The audit invariant `scanned === reverted + deleted + skipped + failed`
 * holds with `skipped = typeACount + typeCCount`.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeFillOnly } from '../../../../src/rollback/strategies/fill-only.js';
import { createRollbackAudit } from '../../../../src/rollback/audit.js';
import { makeRollbackStubService } from '../_stub-service.js';
import type { TypeTableEntry } from '../../../../src/rollback/type-table.js';
import type { MigrationCtx } from '../../../../src/ctx/types.js';

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
// Shared fake ctx (Phase 6 / CTX-01 retrofit)
// ---------------------------------------------------------------------------

function makeFakeCtx(): MigrationCtx {
  return {
    entity: vi.fn(() => { throw new Error('test should not call ctx.entity'); }) as never,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeFillOnly', () => {
  it('empty classifier → no down() calls; no batch flush; audit 0s; invariant holds', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx = makeFakeCtx();

    const downSpy = vi.fn();
    (migration as Record<string, unknown>).down = downSpy;

    await executeFillOnly({
      classify: makeClassifier([]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      ctx: fakeCtx,
    });

    expect(downSpy.mock.calls).toHaveLength(0);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('3 type A → 0 down() calls; batch flush not called or empty; scanned=3, skipped=3, reverted=0', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx = makeFakeCtx();

    const downSpy = vi.fn();
    (migration as Record<string, unknown>).down = downSpy;

    const entries = [1, 2, 3].map((i) => makeTypeA(`u-${i}`));

    await executeFillOnly({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      ctx: fakeCtx,
    });

    expect(downSpy.mock.calls).toHaveLength(0);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.skipped).toBe(3);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('3A + 2B + 2C → 2 down() calls; batch flush with 2 puts; scanned=7, reverted=2, skipped=5 (3A+2C)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx = makeFakeCtx();

    const downSpy = vi.fn(async (record: unknown, _ctx?: unknown) => {
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
      makeTypeC('u-6'),
      makeTypeC('u-7'),
    ];

    await executeFillOnly({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      ctx: fakeCtx,
    });

    // Only type B calls down()
    expect(downSpy.mock.calls).toHaveLength(2);
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(7);
    expect(counts.reverted).toBe(2);
    expect(counts.skipped).toBe(5); // 3 A + 2 C
    expect(counts.deleted).toBe(0);
    expect(counts.failed).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  it('down() throws on 1st type B → audit.failed=1; batch flush NOT called; error rethrows', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx = makeFakeCtx();

    const downSpy = vi.fn(async (_record?: unknown, _ctx?: unknown) => {
      throw new Error('fill-only down failed');
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entries: TypeTableEntry[] = [
      makeTypeA('u-1'),
      makeTypeB('u-2'), // this should throw
      makeTypeB('u-3'),
    ];

    await expect(
      executeFillOnly({
        classify: makeClassifier(entries),
        migration: migration as never,
        client: stub.client as never,
        tableName: 'test-table',
        audit,
        ctx: fakeCtx,
      }),
    ).rejects.toThrow('fill-only down failed');

    const counts = audit.snapshot();
    expect(counts.failed).toBe(1);
    // scanned = 2 (u-1 type A, u-2 type B before throw)
    expect(counts.scanned).toBe(2);
    // Batch flush was NOT called
    const batchCalls = stub.captured.filter((c) => c.op === 'batch-write');
    expect(batchCalls).toHaveLength(0);
  });

  it('type A/C records do NOT invoke down() — only type B calls down()', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx = makeFakeCtx();

    const downSpy = vi.fn(async (record: unknown, _ctx?: unknown) => {
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const bCount = 2;
    const entries: TypeTableEntry[] = [
      makeTypeA('u-1'),
      makeTypeA('u-2'),
      makeTypeC('u-3'),
      makeTypeC('u-4'),
      makeTypeB('u-b1'),
      makeTypeB('u-b2'),
    ];

    await executeFillOnly({
      classify: makeClassifier(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      ctx: fakeCtx,
    });

    // down() should only be called for type B records
    expect(downSpy.mock.calls).toHaveLength(bCount);
    const counts = audit.snapshot();
    expect(counts.skipped).toBe(4); // 2 A + 2 C
    expect(counts.reverted).toBe(bCount);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // CTX-01 retrofit contract test (Pitfall 4 / RESEARCH §A6)
  // --------------------------------------------------------------------------

  it('passes ctx as the second argument to migration.down for type B (CTX-01 retrofit, Pitfall 4)', async () => {
    const stub = makeRollbackStubService();
    const migration = stub.makeMigration({ hasDown: true });
    const audit = createRollbackAudit();
    const fakeCtx: MigrationCtx = { entity: vi.fn() as never };

    const downSpy = vi.fn(async (record: unknown, _ctx?: unknown) => {
      const r = record as Record<string, unknown>;
      const { status: _s, ...v1Shape } = r;
      return v1Shape;
    });
    (migration as Record<string, unknown>).down = downSpy;

    const entry = makeTypeB('u-ctx-check');

    await executeFillOnly({
      classify: makeClassifier([entry]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      ctx: fakeCtx,
    });

    expect(downSpy).toHaveBeenCalledTimes(1);
    // The second argument must be the fakeCtx (CTX-01: down receives ctx)
    expect(downSpy.mock.calls[0]).toEqual([expect.any(Object), fakeCtx]);
  });
});
