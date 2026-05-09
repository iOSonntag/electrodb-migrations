/**
 * Unit tests for `executeCustom` (RBK-08).
 *
 * Tests the per-record resolver dispatch and three-way result dispatch:
 *   - resolver returns v1-shaped record → PUT
 *   - resolver returns null → DELETE v1 mirror (type A/C) or SKIP (type B)
 *   - resolver returns undefined → treated as null (additive widening)
 *   - resolver throws → audit.failed++ and rethrow
 *   - resolver returns v2-shaped / non-object → validateResolverResult throws
 *
 * Per-type action table (RESEARCH §Section 4 lines 1208-1219):
 *   | Type | resolver=null result                                     | resolver=object |
 *   |------|----------------------------------------------------------|-----------------|
 *   | A    | v1Deletes.push(v1Original) → deleted++                   | puts.push(v1)   |
 *   | B    | no-op (v1 doesn't exist for B) → skipped++               | puts.push(v1)   |
 *   | C    | v1Deletes.push(v1Original) → deleted++                   | puts.push(v1)   |
 *
 * @see src/rollback/strategies/custom.ts (module under test)
 * @see src/rollback/resolver-validate.ts (Pitfall 3 mitigation, Plan 05-04)
 * @see RESEARCH §Section 4 lines 1208-1219, Pitfall 3 lines 610-637
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TypeTableEntry } from '../../../../src/rollback/type-table.js';
import { createRollbackAudit } from '../../../../src/rollback/audit.js';
import { executeCustom, type ExecuteCustomArgs } from '../../../../src/rollback/strategies/custom.js';
import { makeRollbackStubService } from '../_stub-service.js';

// ---------------------------------------------------------------------------
// Test helper: build an AsyncGenerator from a fixed array of TypeTableEntries
// ---------------------------------------------------------------------------

async function* makeClassify(entries: TypeTableEntry[]): AsyncGenerator<TypeTableEntry> {
  for (const e of entries) yield e;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal v1-shaped record for type A tests. */
const v1Alice: Record<string, unknown> = { id: 'u-1', name: 'Alice' };
/** Minimal v2-shaped record for type A/B tests. */
const v2Alice: Record<string, unknown> = { id: 'u-1', name: 'Alice', status: 'active' };

/** Type A entry — v1 mirror exists alongside v2. */
function entryA(id = 'u-1'): TypeTableEntry {
  return {
    type: 'A',
    v1Original: { id, name: 'Alice' },
    v2: { id, name: 'Alice', status: 'active' },
    domainKey: `id=${id}`,
  };
}

/** Type B entry — v2-only (no v1 mirror). */
function entryB(id = 'u-2'): TypeTableEntry {
  return {
    type: 'B',
    v2: { id, name: 'Bob', status: 'active' },
    domainKey: `id=${id}`,
  };
}

/** Type C entry — v1-only (never migrated). */
function entryC(id = 'u-3'): TypeTableEntry {
  return {
    type: 'C',
    v1Original: { id, name: 'Carol' },
    domainKey: `id=${id}`,
  };
}

// ---------------------------------------------------------------------------
// Main test suite
// ---------------------------------------------------------------------------

describe('executeCustom (RBK-08)', () => {
  let stubSvc = makeRollbackStubService();

  beforeEach(() => {
    stubSvc = makeRollbackStubService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Case 1: Empty classifier
  // --------------------------------------------------------------------------

  it('empty classifier → batchFlushRollback called once with empty puts/v1Deletes; audit zeros', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (_args: unknown) => null);
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const args: ExecuteCustomArgs = {
      classify: makeClassify([]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 2: 5 Type A records, resolver returns v1Original → 5 puts
  // --------------------------------------------------------------------------

  it('5 Type A + resolver returns v1Original → audit.reverted=5, deleted=0', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as { v1Original?: Record<string, unknown> };
      return a.v1Original ?? null;
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const entries = Array.from({ length: 5 }, (_, i) => entryA(`u-${i + 1}`));

    const args: ExecuteCustomArgs = {
      classify: makeClassify(entries),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.reverted).toBe(5);
    expect(counts.deleted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
    expect(resolverSpy).toHaveBeenCalledTimes(5);
  });

  // --------------------------------------------------------------------------
  // Case 3: 5 Type B records, resolver returns await down(v2) → 5 puts
  // --------------------------------------------------------------------------

  it('5 Type B + resolver returns down(v2) → audit.reverted=5', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasDown: true, hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as { kind: 'B'; v2?: Record<string, unknown>; down?: (r: unknown) => Promise<unknown> };
      if (!a.down || !a.v2) return null;
      return await a.down(a.v2);
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const entries = Array.from({ length: 5 }, (_, i) => entryB(`u-${i + 10}`));

    const args: ExecuteCustomArgs = {
      classify: makeClassify(entries),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.reverted).toBe(5);
    expect(counts.failed).toBe(0);
    expect(resolverSpy).toHaveBeenCalledTimes(5);
  });

  // --------------------------------------------------------------------------
  // Case 4: 3 Type C records, resolver returns null → 3 v1Deletes
  // --------------------------------------------------------------------------

  it('3 Type C + resolver returns null → audit.deleted=3', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (_args: unknown) => null);
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const entries = [entryC('u-1'), entryC('u-2'), entryC('u-3')];

    const args: ExecuteCustomArgs = {
      classify: makeClassify(entries),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(3);
    expect(counts.deleted).toBe(3);
    expect(counts.reverted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case 5: Mixed 2A + 2B + 2C — A puts, B down, C null → 4 puts + 2 v1Deletes
  // --------------------------------------------------------------------------

  it('mixed 2A+2B+2C: A puts, B down, C null → audit.reverted=4, deleted=2, skipped=0', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasDown: true, hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as {
        kind: 'A' | 'B' | 'C';
        v1Original?: Record<string, unknown>;
        v2?: Record<string, unknown>;
        down?: (r: unknown) => Promise<unknown>;
      };
      if (a.kind === 'A') return a.v1Original ?? null;
      if (a.kind === 'B') {
        if (!a.down || !a.v2) return null;
        return await a.down(a.v2);
      }
      // C → null → delete
      return null;
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const entries = [
      entryA('u-1'), entryA('u-2'),
      entryB('u-3'), entryB('u-4'),
      entryC('u-5'), entryC('u-6'),
    ];

    const args: ExecuteCustomArgs = {
      classify: makeClassify(entries),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(6);
    expect(counts.reverted).toBe(4);
    expect(counts.deleted).toBe(2);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case 6: 1 Type B + resolver returns null → skipped (v1 doesn't exist for B)
  // --------------------------------------------------------------------------

  it('1 Type B + resolver returns null → audit.skipped=1 (v1 does not exist for B)', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (_args: unknown) => null);
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const args: ExecuteCustomArgs = {
      classify: makeClassify([entryB()]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(counts.reverted).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.failed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case 7: 1 Type A, resolver throws → audit.failed=1, error bubbles, no batch flush
  // --------------------------------------------------------------------------

  it('1 Type A, resolver throws → audit.failed=1, audit.scanned=1, error bubbles', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverError = new Error('resolver-boom');
    const resolverSpy = vi.fn().mockRejectedValue(resolverError);
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const args: ExecuteCustomArgs = {
      classify: makeClassify([entryA()]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await expect(executeCustom(args)).rejects.toThrow('resolver-boom');

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(1);
    expect(counts.failed).toBe(1);
    // batch flush should not have been called since error was thrown mid-loop
    expect(stubSvc.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 8: 1 Type A, resolver returns v2-shaped object → validateResolverResult throws,
  //          audit.failed=1, domainKey preserved in error message
  // --------------------------------------------------------------------------

  it('1 Type A, resolver returns v2-shape (name=42 wrong type) → validateResolverResult throws, audit.failed=1, domainKey in error', async () => {
    const audit = createRollbackAudit();
    // Use the real v1 entity so validateResolverResult can run ElectroDB schema validation.
    // We get it from the sample-migration fixture.
    const { createUserAddStatusWithResolverMigration } = await import(
      '../../../../tests/_helpers/sample-migrations/User-add-status-with-resolver/index.js'
    );
    const realMigration = createUserAddStatusWithResolverMigration(
      stubSvc.client as never,
      'test-table',
    );
    // Override resolver to return a v2-shaped record with wrong name type
    // (ElectroDB will throw on name:42 since name is type 'string' required)
    const badRecord = { id: 'u-1', name: 42, status: 'active' };
    const resolverSpy = vi.fn(async (_args: unknown) => badRecord);
    (realMigration as unknown as Record<string, unknown>).rollbackResolver = resolverSpy;

    const domainKey = 'id=u-1';
    const args: ExecuteCustomArgs = {
      classify: makeClassify([entryA()]),
      migration: realMigration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await expect(executeCustom(args)).rejects.toThrow(domainKey);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(1);
    expect(counts.failed).toBe(1);
    expect(stubSvc.batchWriteSendSpy).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Case 9: 1 Type A, resolver returns undefined → treated as null → v1Delete
  // --------------------------------------------------------------------------

  it('1 Type A, resolver returns undefined → treated as null → v1Delete (type A)', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (_args: unknown) => undefined);
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const args: ExecuteCustomArgs = {
      classify: makeClassify([entryA()]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(1);
    expect(counts.deleted).toBe(1);
    expect(counts.reverted).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.failed).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Case 10: 1 Type A, resolver returns 'string' → validateResolverResult throws, audit.failed=1
  // --------------------------------------------------------------------------

  it('1 Type A, resolver returns string → validateResolverResult throws, audit.failed=1', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (_args: unknown) => 'not-a-record');
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const args: ExecuteCustomArgs = {
      classify: makeClassify([entryA()]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await expect(executeCustom(args)).rejects.toThrow();

    const counts = audit.snapshot();
    expect(counts.scanned).toBe(1);
    expect(counts.failed).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Case 11: Resolver receives EXACT shape of RollbackResolverArgs
  //           For type A: kind, v1Original, v2, down all present
  // --------------------------------------------------------------------------

  it('resolver receives exact RollbackResolverArgs shape for type A (kind, v1Original, v2, down)', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasDown: true, hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as { v1Original?: Record<string, unknown> };
      return a.v1Original ?? null;
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const e = entryA();
    const args: ExecuteCustomArgs = {
      classify: makeClassify([e]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    expect(resolverSpy).toHaveBeenCalledTimes(1);
    const callArgs = resolverSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).toHaveProperty('kind', 'A');
    expect(callArgs).toHaveProperty('v1Original');
    expect(callArgs).toHaveProperty('v2');
    expect(callArgs).toHaveProperty('down');
  });

  // --------------------------------------------------------------------------
  // Case 12: For type B, v1Original is undefined in resolver args
  // --------------------------------------------------------------------------

  it('for type B, v1Original is absent (undefined) in resolver args', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasDown: true, hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as { v2?: Record<string, unknown>; down?: (r: unknown) => Promise<unknown> };
      if (!a.down || !a.v2) return null;
      return await a.down(a.v2);
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const e = entryB();
    const args: ExecuteCustomArgs = {
      classify: makeClassify([e]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    expect(resolverSpy).toHaveBeenCalledTimes(1);
    const callArgs = resolverSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).toHaveProperty('kind', 'B');
    expect(callArgs.v1Original).toBeUndefined();
    expect(callArgs).toHaveProperty('v2');
  });

  // --------------------------------------------------------------------------
  // Case 13: For type C, v2 is absent (undefined) in resolver args
  // --------------------------------------------------------------------------

  it('for type C, v2 is absent (undefined) in resolver args', async () => {
    const audit = createRollbackAudit();
    const migration = stubSvc.makeMigration({ hasRollbackResolver: true });
    const resolverSpy = vi.fn(async (args: unknown) => {
      const a = args as { v1Original?: Record<string, unknown> };
      return a.v1Original ?? null;
    });
    (migration as Record<string, unknown>).rollbackResolver = resolverSpy;

    const e = entryC();
    const args: ExecuteCustomArgs = {
      classify: makeClassify([e]),
      migration: migration as never,
      client: stubSvc.client as never,
      tableName: 'test-table',
      audit,
    };

    await executeCustom(args);

    expect(resolverSpy).toHaveBeenCalledTimes(1);
    const callArgs = resolverSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).toHaveProperty('kind', 'C');
    expect(callArgs.v2).toBeUndefined();
    expect(callArgs).toHaveProperty('v1Original');
  });
});
