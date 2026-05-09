/**
 * RBK-06 + VALIDATION invariants 5, 13 — snapshot strategy integration tests.
 *
 * Snapshot strategy: type B records are DELETED (DATA LOSS); type A/C kept.
 * This is the only DATA-LOSS-bearing rollback strategy.
 *
 * Test cases:
 *   1. Case 2 snapshot --yes:    warning to stderr; type B deleted; v1 count = 5; v2 count = 3
 *   2. Case 2 interactive proceed: prompt called once; same end-state
 *   3. Case 2 interactive abort:  prompt called once; no DDB writes; all counts unchanged
 *   4. Case 3 snapshot refusal:   preconditions refuses with FINALIZED_ONLY_PROJECTED
 *
 * References:
 *   - RBK-06: snapshot rollback strategy
 *   - VALIDATION invariant 5: DATA LOSS for type B; no v2 delete for type A/C
 *   - VALIDATION invariant 13: snapshot emits warning to stderr (Pitfall 8)
 *   - RESEARCH §Section 4 lines 1188-1198
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rollback } from '../../../src/rollback/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { type RollbackTestTableSetup, setupRollbackTestTable } from './_helpers.js';

/** Fast config — short acquireWaitMs so tests run quickly. */
const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 100 },
  guard: { cacheTtlMs: 50, blockMode: 'all' as const },
  entities: [],
  migrations: '',
  region: undefined,
  tableName: '',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// Mixed cell configuration: 3 A + 2 B + 2 C = 7 total; after snapshot: v1=5 (3A+2C), v2=3 (3A)
// Type B (2) are deleted; Type A (3) kept in v1+v2; Type C (2) kept in v1 only
const SEED = { mixed: { aCount: 3, bCount: 2, cCount: 2 } };

// ---------------------------------------------------------------------------
// Test 1: Case 2 snapshot --yes
// ---------------------------------------------------------------------------

describe('RBK-06 snapshot: Case 2 with --yes flag', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: SEED,
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('snapshot --yes: warning emitted to stderr; v1=5; v2=3; rollbackStrategy=snapshot', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const stderrChunks: string[] = [];
    const io = {
      stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
    };

    await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'snapshot',
      yes: true,
      io,
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    const stderrText = stderrChunks.join('');
    // Pitfall 8 / VALIDATION invariant 13: DATA LOSS warning always emitted even with --yes
    expect(stderrText).toContain('Type B');
    expect(stderrText).toMatch(/DATA LOSS|Type B/i);
    expect(stderrText).toContain('2'); // 2 fresh v2 records deleted

    // After snapshot: v1 has A+C records = 5; v2 has A records = 3 (B deleted)
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);
    expect(postV2.data.length).toBe(3);

    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; rollbackStrategy: string } | null;
    };
    expect(migRow.data?.rollbackStrategy).toBe('snapshot');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2: Case 2 snapshot interactive proceed
// ---------------------------------------------------------------------------

describe('RBK-06 snapshot: Case 2 interactive proceed', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: SEED,
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('snapshot interactive proceed: confirm called once; same end-state as --yes', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const confirmFn = vi.fn(async (_prompt: string) => true);
    const stderrChunks: string[] = [];
    const io = {
      stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
      confirm: confirmFn,
    };

    await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'snapshot',
      io,
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Prompt called exactly once
    expect(confirmFn).toHaveBeenCalledTimes(1);

    // End state: same as --yes
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);
    expect(postV2.data.length).toBe(3);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 3: Case 2 snapshot interactive abort
// ---------------------------------------------------------------------------

describe('RBK-06 snapshot: Case 2 interactive abort', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: SEED,
      migrationsRowStatus: 'applied',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('snapshot interactive abort: confirm returns false; v1 count=5 (unchanged), v2 count=5 (unchanged); status=reverted', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const confirmFn = vi.fn(async (_prompt: string) => false); // operator aborts
    const stderrChunks: string[] = [];
    const io = {
      stderr: { write: (s: string) => { stderrChunks.push(s); return true; } },
      confirm: confirmFn,
    };

    // Pre-condition: 5 v1 + 5 v2 (3A: v1+v2; 2B: v2 only; 2C: v1 only)
    const preV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    const preV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(preV1.data.length).toBe(5);
    expect(preV2.data.length).toBe(5);

    await rollback({
      service: setup.service,
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migration: setup.migration,
      strategy: 'snapshot',
      io,
      runId: randomUUID(),
      holder: 'test-host:1234',
    });

    // Prompt called once; operator aborted
    expect(confirmFn).toHaveBeenCalledTimes(1);

    // Post-condition: no DDB writes (user aborted) — counts unchanged
    const postV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    const postV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: unknown[] };
    expect(postV1.data.length).toBe(5);
    expect(postV2.data.length).toBe(5);

    // _migrations.status = 'reverted' (per Plan 05-06's user-aborted disposition)
    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string } | null;
    };
    expect(migRow.data?.status).toBe('reverted');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 4: Case 3 snapshot refusal — FINALIZED_ONLY_PROJECTED
// ---------------------------------------------------------------------------

describe('RBK-06 snapshot: Case 3 refusal — FINALIZED_ONLY_PROJECTED', () => {
  let alive = false;
  let setup: RollbackTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;

    setup = await setupRollbackTestTable({
      fixture: 'with-down',
      seed: { v2Count: 3 },
      migrationsRowStatus: 'finalized',
    });
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('Case 3 snapshot refusal: throws EDBRollbackNotPossibleError with FINALIZED_ONLY_PROJECTED', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    await expect(
      rollback({
        service: setup.service,
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migration: setup.migration,
        strategy: 'snapshot',
        yes: true,
        runId: randomUUID(),
        holder: 'test-host:1234',
      }),
    ).rejects.toMatchObject({ details: { reason: 'FINALIZED_ONLY_PROJECTED' } });
  }, 30_000);
});
