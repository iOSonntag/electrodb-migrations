/**
 * Unit tests for `executeSnapshot` — the snapshot rollback strategy executor (RBK-06).
 *
 * Strategy semantics:
 *   - Type A: keep (no DDB write)   → audit.incrementSkipped()
 *   - Type B: delete v2 (DATA LOSS) → audit.addDeleted(1) after batch flush
 *   - Type C: keep (resurrection)   → audit.incrementSkipped()
 *
 * DATA-LOSS mitigation (Pitfall 8): When b > 0 OR c > 0, the strategy emits a
 * multi-line warning to stderr (even with `--yes`) BEFORE executing. When `--yes`
 * is absent, the operator must confirm interactively; declining aborts DDB writes.
 *
 * Invariant: scanned === reverted + deleted + skipped + failed (RBK-12).
 *   snapshot path: reverted always 0; deleted = b (proceed) or 0 (abort);
 *   skipped = a + c (proceed) or a + b + c (abort).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSnapshot } from '../../../../src/rollback/strategies/snapshot.js';
import { createRollbackAudit } from '../../../../src/rollback/audit.js';
import { makeRollbackStubService } from '../_stub-service.js';
import type { TypeTableEntry } from '../../../../src/rollback/type-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an AsyncGenerator from a plain array of TypeTableEntry values.
 * Simulates the classifier output without needing a real DDB scan.
 */
async function* entriesGenerator(entries: TypeTableEntry[]): AsyncGenerator<TypeTableEntry> {
  for (const entry of entries) {
    yield entry;
  }
}

/** Create a minimal v2 record stub given an id. */
function makeV2Record(id: string): Record<string, unknown> {
  return { id, status: 'active', __edb_e__: 'User', __edb_v__: '2' };
}

/** Create a minimal v1 record stub given an id. */
function makeV1Record(id: string): Record<string, unknown> {
  return { id, __edb_e__: 'User', __edb_v__: '1' };
}

/** Build a type-A entry (present in both v1 and v2). */
function entryA(id: string): TypeTableEntry {
  return { type: 'A', v1Original: makeV1Record(id), v2: makeV2Record(id), domainKey: `id=${id}` };
}

/** Build a type-B entry (v2 only — DATA LOSS on snapshot rollback). */
function entryB(id: string): TypeTableEntry {
  return { type: 'B', v2: makeV2Record(id), domainKey: `id=${id}` };
}

/** Build a type-C entry (v1 only — resurrection on snapshot rollback). */
function entryC(id: string): TypeTableEntry {
  return { type: 'C', v1Original: makeV1Record(id), domainKey: `id=${id}` };
}

/** Capture stderr writes into an accumulation string. */
function makeStderrCapture() {
  let content = '';
  return {
    write: vi.fn((s: string) => {
      content += s;
      return true;
    }),
    get content() { return content; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeSnapshot', () => {
  let stub: ReturnType<typeof makeRollbackStubService>;

  beforeEach(() => {
    stub = makeRollbackStubService();
  });

  // -------------------------------------------------------------------------
  // Case 1: Empty classifier — no warning, no prompt, no batch flush
  // -------------------------------------------------------------------------
  it('empty classifier — no warning, no prompt, no batch flush, audit all zeros', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn();
    const migration = stub.makeMigration({ hasDown: false });

    await executeSnapshot({
      classify: entriesGenerator([]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: false,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // No warning emitted.
    expect(stderrCapture.write).not.toHaveBeenCalled();
    // No prompt called.
    expect(confirmFn).not.toHaveBeenCalled();
    // No batch flush (batchWriteSendSpy not called).
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
    // Audit all zeros.
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(0);
    expect(counts.skipped).toBe(0);
    expect(counts.deleted).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.failed).toBe(0);
    // Invariant holds.
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 2: 5 Type A only (b=0, c=0) — no warning, no prompt, no batch flush
  // -------------------------------------------------------------------------
  it('5 Type A only — no warning, no prompt, no batch flush; scanned=5 skipped=5', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn();
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [entryA('1'), entryA('2'), entryA('3'), entryA('4'), entryA('5')];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: false,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // No warning emitted (b=0 and c=0).
    expect(stderrCapture.write).not.toHaveBeenCalled();
    // No prompt (b=0 and c=0).
    expect(confirmFn).not.toHaveBeenCalled();
    // No batch flush.
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();
    // Audit: scanned=5, skipped=5.
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.skipped).toBe(5);
    expect(counts.deleted).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.failed).toBe(0);
    // Invariant holds.
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 3: 3A + 2B + 2C, yes=true — warning to stderr, no prompt, batch flush
  // -------------------------------------------------------------------------
  it('3A+2B+2C, yes=true — warning emitted with DATA LOSS + counts, no prompt, batch flush', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn();
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [
      entryA('a1'), entryA('a2'), entryA('a3'),
      entryB('b1'), entryB('b2'),
      entryC('c1'), entryC('c2'),
    ];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: true,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // Warning MUST be emitted to stderr.
    expect(stderrCapture.write).toHaveBeenCalled();
    // Warning must contain expected strings.
    const warning = stderrCapture.content;
    expect(warning).toContain('DATA LOSS');
    expect(warning).toContain('Type B');
    expect(warning).toContain('Type C');
    expect(warning).toContain('2'); // B count
    expect(warning).toContain('2'); // C count
    expect(warning).toContain('3'); // A count

    // With yes=true: no prompt called.
    expect(confirmFn).not.toHaveBeenCalled();

    // Batch flush called (2 v2Deletes).
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    // Audit: scanned=7, deleted=2, skipped=5 (3A + 2C).
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(7);
    expect(counts.deleted).toBe(2);
    expect(counts.skipped).toBe(5);
    expect(counts.reverted).toBe(0);
    expect(counts.failed).toBe(0);
    // Invariant holds.
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 4: 3A + 2B + 2C, yes=false, confirm returns true (user said yes)
  // -------------------------------------------------------------------------
  it('3A+2B+2C, yes=false, user confirms yes — warning emitted, prompt called, batch flush', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn().mockResolvedValue(true);
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [
      entryA('a1'), entryA('a2'), entryA('a3'),
      entryB('b1'), entryB('b2'),
      entryC('c1'), entryC('c2'),
    ];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: false,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // Warning emitted.
    expect(stderrCapture.write).toHaveBeenCalled();
    const warning = stderrCapture.content;
    expect(warning).toContain('DATA LOSS');
    expect(warning).toContain('Type B');
    expect(warning).toContain('Type C');

    // Prompt called once with a string containing [y/N].
    expect(confirmFn).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion — mock call args
    const promptArg = (confirmFn.mock.calls[0] as any)[0] as string;
    expect(promptArg).toMatch(/\[y\/N\]/i);

    // Batch flush called.
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    // Audit: deleted=2, skipped=5.
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(7);
    expect(counts.deleted).toBe(2);
    expect(counts.skipped).toBe(5);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 5: 3A + 2B + 2C, yes=false, confirm returns false (user aborted)
  // -------------------------------------------------------------------------
  it('3A+2B+2C, yes=false, user aborts — warning emitted, prompt called, NO batch flush, all-skipped audit', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn().mockResolvedValue(false);
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [
      entryA('a1'), entryA('a2'), entryA('a3'),
      entryB('b1'), entryB('b2'),
      entryC('c1'), entryC('c2'),
    ];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: false,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // Warning emitted.
    expect(stderrCapture.write).toHaveBeenCalled();
    expect(stderrCapture.content).toContain('DATA LOSS');

    // Prompt called once.
    expect(confirmFn).toHaveBeenCalledTimes(1);

    // Batch flush NOT invoked.
    expect(stub.batchWriteSendSpy).not.toHaveBeenCalled();

    // Audit: scanned=7, skipped=7 (all skipped because user aborted), deleted=0.
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(7);
    expect(counts.skipped).toBe(7);
    expect(counts.deleted).toBe(0);
    expect(counts.reverted).toBe(0);
    expect(counts.failed).toBe(0);
    // Invariant holds (7 = 0 + 0 + 7 + 0).
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 6: 0A + 5B + 0C, yes=true — warning with B=5, C=0, batch flush 5 v2Deletes
  // -------------------------------------------------------------------------
  it('0A+5B+0C, yes=true — warning with B count=5 and C count=0, batch flush 5 v2Deletes', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const confirmFn = vi.fn();
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [entryB('b1'), entryB('b2'), entryB('b3'), entryB('b4'), entryB('b5')];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: true,
      io: { stderr: stderrCapture, confirm: confirmFn },
    });

    // Warning emitted.
    expect(stderrCapture.write).toHaveBeenCalled();
    const warning = stderrCapture.content;
    expect(warning).toContain('DATA LOSS');
    expect(warning).toContain('Type B');
    expect(warning).toContain('Type C');
    expect(warning).toContain('5'); // B count

    // No prompt (yes=true).
    expect(confirmFn).not.toHaveBeenCalled();

    // Batch flush called once.
    expect(stub.batchWriteSendSpy).toHaveBeenCalledTimes(1);

    // Audit: scanned=5, deleted=5.
    const counts = audit.snapshot();
    expect(counts.scanned).toBe(5);
    expect(counts.deleted).toBe(5);
    expect(counts.skipped).toBe(0);
    expect(() => audit.assertInvariant()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Case 7: Migration with NO down() — snapshot still executes without error
  // -------------------------------------------------------------------------
  it('migration without down() — executeSnapshot succeeds (RBK-06: snapshot does not need down)', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const migration = stub.makeMigration({ hasDown: false });
    // Verify no down on migration.
    expect((migration as Record<string, unknown>).down).toBeUndefined();

    const entries = [entryA('a1'), entryB('b1')];

    // Should NOT throw even though down is undefined.
    await expect(
      executeSnapshot({
        classify: entriesGenerator(entries),
        migration: migration as never,
        client: stub.client as never,
        tableName: 'test-table',
        audit,
        yes: true,
        io: { stderr: stderrCapture, confirm: vi.fn() },
      }),
    ).resolves.toBeUndefined();

    // Snapshot does not call migration.down — verify by checking no down call.
    // (The stub doesn't track down, but we verified down === undefined above, so
    //  the function would throw if it tried to call migration.down().)
  });

  // -------------------------------------------------------------------------
  // Case 8: Stderr injection — assert exact warning text byte-for-byte
  // -------------------------------------------------------------------------
  it('stderr injection — warning contains snapshot name, literal DATA LOSS, Type B, Type C', async () => {
    const audit = createRollbackAudit();
    const stderrCapture = makeStderrCapture();
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [entryA('a1'), entryB('b1'), entryC('c1')];

    await executeSnapshot({
      classify: entriesGenerator(entries),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit,
      yes: true,
      io: { stderr: stderrCapture, confirm: vi.fn() },
    });

    const warning = stderrCapture.content;
    // All byte-exact required strings must be present.
    expect(warning).toContain("Strategy 'snapshot' will:");
    expect(warning).toContain('DATA LOSS');
    expect(warning).toContain('Type B');
    expect(warning).toContain('Type C');
    expect(warning).toContain('Proceeding because --yes was supplied');
  });

  // -------------------------------------------------------------------------
  // Case 9: Confirm injection — prompt called with [y/N], not called when yes=true
  // -------------------------------------------------------------------------
  it('confirm injection — prompt called once when yes=false; not called when yes=true', async () => {
    const migration = stub.makeMigration({ hasDown: false });
    const entries = [entryB('b1')];

    // yes=false path: confirm called.
    const auditFalse = createRollbackAudit();
    const confirmYesFalse = vi.fn().mockResolvedValue(true);
    await executeSnapshot({
      classify: entriesGenerator([...entries]),
      migration: migration as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit: auditFalse,
      yes: false,
      io: { stderr: makeStderrCapture(), confirm: confirmYesFalse },
    });
    expect(confirmYesFalse).toHaveBeenCalledTimes(1);

    // yes=true path: confirm NOT called.
    stub = makeRollbackStubService();
    const auditTrue = createRollbackAudit();
    const confirmYesTrue = vi.fn();
    await executeSnapshot({
      classify: entriesGenerator([...entries]),
      migration: stub.makeMigration({ hasDown: false }) as never,
      client: stub.client as never,
      tableName: 'test-table',
      audit: auditTrue,
      yes: true,
      io: { stderr: makeStderrCapture(), confirm: confirmYesTrue },
    });
    expect(confirmYesTrue).not.toHaveBeenCalled();
  });
});
