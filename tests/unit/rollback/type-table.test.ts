/**
 * Unit tests for `classifyTypeTable` — the RBK-04 four-cell type-table
 * classifier AsyncGenerator. Uses the rollback stub service from Plan 05-01
 * (`makeRollbackStubService`) to drive the two-queue scan capture.
 *
 * Coverage:
 *   - Empty table (both scans empty) → generator yields nothing.
 *   - 5 v1, 0 v2 → 5 Type C entries.
 *   - 0 v1, 5 v2 → 5 Type B entries.
 *   - 5 v1, 5 v2 (all matching by id) → 5 Type A entries.
 *   - 3 v1, 5 v2 (2 fresh v2 ids not in v1) → 3 Type A + 2 Type B.
 *   - 5 v1, 3 v2 (2 v1 ids not in v2) → 3 Type A + 2 Type C.
 *   - Multi-page v1 scan (25 records, pageSize=10) → all 25 Type C, no double-count.
 *   - consistent: CONSISTENT_READ is passed to every scan call (verified via stub).
 *
 * Reference: Plan 05-03, RESEARCH §Section 3 lines 1086-1163.
 */

import { describe, expect, it } from 'vitest';
import { CONSISTENT_READ } from '../../../src/safety/index.js';
import { classifyTypeTable, type TypeTableEntry } from '../../../src/rollback/type-table.js';
import { makeRollbackStubService } from './_stub-service.js';

// ---------------------------------------------------------------------------
// Helpers to build stub records
// ---------------------------------------------------------------------------

/** Create a minimal v1-shaped record with a given id. */
function v1Record(id: string): Record<string, unknown> {
  return { __edb_e__: 'User', __edb_v__: '1', id, name: `name-${id}` };
}

/** Create a minimal v2-shaped record with a given id. */
function v2Record(id: string): Record<string, unknown> {
  return { __edb_e__: 'User', __edb_v__: '2', id, name: `name-${id}`, status: 'active', version: 'v2' };
}

/**
 * Collect all entries from the AsyncGenerator into an array.
 */
async function collectEntries(
  gen: AsyncGenerator<TypeTableEntry>,
): Promise<TypeTableEntry[]> {
  const entries: TypeTableEntry[] = [];
  for await (const e of gen) {
    entries.push(e);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The stub's makeMigration uses a stub entity that returns the scan data
// directly from the queue. The domainKey for stub records is keyed by 'id'
// because the stub entity is built with schema.indexes.byId.pk.composite = ['id'].
//
// HOWEVER: the stub entity does NOT implement schema.indexes.byId.pk.composite
// or entity.parse — extractDomainKey needs those. So we need to provide a
// minimal entity stub that implements those interfaces.
//
// Looking at _stub-service.ts, the makeV1EntityStub / makeV2EntityStub don't
// implement parse or schema. We need to add those for classifyTypeTable to work.
// We'll use a custom migration factory for these tests.
// ---------------------------------------------------------------------------

/** Build a minimal entity-like stub that classifyTypeTable can consume. */
function makeEntityStub(
  stub: ReturnType<typeof makeRollbackStubService>,
  version: 'v1' | 'v2',
) {
  const base = version === 'v1' ? stub.makeMigration().from : stub.makeMigration().to;
  return {
    ...base,
    // Add parse + schema for extractDomainKey
    schema: {
      indexes: {
        byId: {
          pk: {
            composite: ['id'],
          },
        },
      },
    },
    parse: (args: { Item: Record<string, unknown> }) => ({
      data: { id: args.Item.id },
    }),
    ownsItem: (item: Record<string, unknown>) => item.__edb_v__ === (version === 'v1' ? '1' : '2'),
  };
}

/**
 * Build a migration stub that wires the scan queues with the extended entity
 * stubs needed for classifyTypeTable (adds schema + parse for extractDomainKey).
 */
function makeMigrationWithDomainKey(stub: ReturnType<typeof makeRollbackStubService>) {
  const raw = stub.makeMigration();
  // Extend the from/to entities with schema and parse methods.
  const from = {
    ...raw.from,
    schema: {
      indexes: {
        byId: {
          pk: {
            composite: ['id'],
          },
        },
      },
    },
    parse: (args: { Item: Record<string, unknown> }) => ({
      data: { id: args.Item.id },
    }),
  };
  const to = {
    ...raw.to,
    schema: {
      indexes: {
        byId: {
          pk: {
            composite: ['id'],
          },
        },
      },
    },
    parse: (args: { Item: Record<string, unknown> }) => ({
      data: { id: args.Item.id },
    }),
  };
  return {
    ...raw,
    from,
    to,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('classifyTypeTable', () => {
  it('yields nothing when both v1 and v2 scans return empty pages', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v1', []);
    stub.setScanPages('v2', []);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(0);
  });

  it('yields 5 Type C entries when 5 v1 records exist and 0 v2 records', async () => {
    const stub = makeRollbackStubService();
    const v1Records = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5'].map(v1Record);
    stub.setScanPages('v1', [v1Records]);
    stub.setScanPages('v2', []);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.type === 'C')).toBe(true);
    // v1Original is set on every Type C entry.
    expect(entries.every((e) => e.v1Original !== undefined)).toBe(true);
    // v2 is undefined for Type C.
    expect(entries.every((e) => e.v2 === undefined)).toBe(true);
  });

  it('yields 5 Type B entries when 0 v1 records exist and 5 v2 records', async () => {
    const stub = makeRollbackStubService();
    const v2Records = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5'].map(v2Record);
    stub.setScanPages('v1', []);
    stub.setScanPages('v2', [v2Records]);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.type === 'B')).toBe(true);
    // v2 is set on every Type B entry.
    expect(entries.every((e) => e.v2 !== undefined)).toBe(true);
    // v1Original is undefined for Type B.
    expect(entries.every((e) => e.v1Original === undefined)).toBe(true);
  });

  it('yields 5 Type A entries when 5 v1 and 5 v2 records all share the same ids', async () => {
    const stub = makeRollbackStubService();
    const ids = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5'];
    stub.setScanPages('v1', [ids.map(v1Record)]);
    stub.setScanPages('v2', [ids.map(v2Record)]);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.type === 'A')).toBe(true);
    // Both v1Original and v2 are populated for Type A.
    expect(entries.every((e) => e.v1Original !== undefined && e.v2 !== undefined)).toBe(true);
    // domainKey is consistent across v1 and v2.
    expect(entries.map((e) => e.domainKey)).toEqual(ids.map((id) => `id=${id}`));
  });

  it('yields 3 Type A + 2 Type B when v2 includes 2 fresh ids not in v1 (3 matching, 2 v2-only)', async () => {
    const stub = makeRollbackStubService();
    const sharedIds = ['u-1', 'u-2', 'u-3'];
    const freshIds = ['u-4', 'u-5'];
    stub.setScanPages('v1', [sharedIds.map(v1Record)]);
    stub.setScanPages('v2', [[...sharedIds.map(v2Record), ...freshIds.map(v2Record)]]);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(5);
    const typeA = entries.filter((e) => e.type === 'A');
    const typeB = entries.filter((e) => e.type === 'B');
    expect(typeA).toHaveLength(3);
    expect(typeB).toHaveLength(2);
    // Type B entries have the fresh ids.
    const typeBKeys = typeB.map((e) => e.domainKey).sort();
    expect(typeBKeys).toEqual(['id=u-4', 'id=u-5']);
  });

  it('yields 3 Type A + 2 Type C when 2 v1 ids are not in v2 (3 matching, 2 v1-only)', async () => {
    const stub = makeRollbackStubService();
    const sharedIds = ['u-1', 'u-2', 'u-3'];
    const v1OnlyIds = ['u-4', 'u-5'];
    stub.setScanPages('v1', [[...sharedIds.map(v1Record), ...v1OnlyIds.map(v1Record)]]);
    stub.setScanPages('v2', [sharedIds.map(v2Record)]);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any }));
    expect(entries).toHaveLength(5);
    const typeA = entries.filter((e) => e.type === 'A');
    const typeC = entries.filter((e) => e.type === 'C');
    expect(typeA).toHaveLength(3);
    expect(typeC).toHaveLength(2);
    // Type C entries are emitted AFTER the v2 scan completes.
    const typeCKeys = typeC.map((e) => e.domainKey).sort();
    expect(typeCKeys).toEqual(['id=u-4', 'id=u-5']);
  });

  it('handles multi-page v1 scan (25 records, pageSize=10) — yields all 25 Type C, no double-counting', async () => {
    const stub = makeRollbackStubService();
    // 25 records across 3 pages: 10 + 10 + 5.
    const allIds = Array.from({ length: 25 }, (_, i) => `u-${i + 1}`);
    const page1 = allIds.slice(0, 10).map(v1Record);
    const page2 = allIds.slice(10, 20).map(v1Record);
    const page3 = allIds.slice(20, 25).map(v1Record);
    // setScanPages accepts an array of pages (nested array).
    stub.setScanPages('v1', [page1, page2, page3]);
    stub.setScanPages('v2', []);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    const entries = await collectEntries(classifyTypeTable({ migration: migration as any, pageSize: 10 }));
    expect(entries).toHaveLength(25);
    expect(entries.every((e) => e.type === 'C')).toBe(true);
    // Each domain key appears exactly once (no double-counting).
    const keys = entries.map((e) => e.domainKey);
    expect(new Set(keys).size).toBe(25);
  });

  it('passes consistent: CONSISTENT_READ to every scan call (v1 + v2 scans)', async () => {
    const stub = makeRollbackStubService();
    stub.setScanPages('v1', [['u-1', 'u-2'].map(v1Record)]);
    stub.setScanPages('v2', [['u-1', 'u-2'].map(v2Record)]);
    const migration = makeMigrationWithDomainKey(stub);

    // biome-ignore lint/suspicious/noExplicitAny: migration stub type
    await collectEntries(classifyTypeTable({ migration: migration as any }));

    // All scan captures should have consistent: CONSISTENT_READ (true).
    const scanCaptures = stub.captured.filter((c) => c.op === 'scan');
    expect(scanCaptures.length).toBeGreaterThan(0);
    expect(
      scanCaptures.every((c) => (c.scanOpts as Record<string, unknown>)?.consistent === CONSISTENT_READ),
    ).toBe(true);
  });
});
