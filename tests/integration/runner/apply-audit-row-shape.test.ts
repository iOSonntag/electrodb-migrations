/**
 * BL-01 gap closure — `_migrations` audit-row shape regression test.
 *
 * Origin: 04-UAT.md Test #2 ("BL-01 audit row shape — single `_migrations` write")
 * + 04-REVIEW-FIX.md. The BL-01 fix landed in commit `22d2fc8` as a source-only
 * change (3 inserts, 24 deletes, zero test files) — the reviewer's recommended
 * regression test was never authored. This file closes that gap.
 *
 * What's pinned:
 *   1. After a full-feature migration apply (down + rollbackResolver + reads),
 *      the on-disk `_migrations` row has fingerprint='', kind='transform',
 *      hasDown===true, hasRollbackResolver===true, and `reads` deserializes
 *      to ['User'] (one declared entity).
 *   2. After a bare migration apply (no down, no rollbackResolver, no reads),
 *      the on-disk `_migrations` row has fingerprint='', kind='transform', and
 *      hasDown / hasRollbackResolver / reads are all ABSENT (undefined when
 *      read back) — the conditional spreads in `applyFlowScanWrite` skipped
 *      them.
 *
 * What this is NOT:
 *   - This is not a throughput test (recordCount=5 per case is sufficient).
 *   - This is not a lock-cycle test (apply-batch / apply-happy-path-1k cover that).
 *   - This is not a finalize-row test (separate finalize.test.ts pins that path).
 *
 * Future-proofing intent: a refactor that re-introduces a second clobbering
 * write, hardcodes any of the three conditional flags, removes the conditional
 * spread, or changes the placeholder fingerprint from `''` to a non-empty
 * default will fail these assertions.
 *
 * @see src/runner/apply-flow.ts (applyFlowScanWrite — the put() under test)
 * @see src/internal-entities/migrations.ts (the `_migrations` schema)
 * @see .planning/phases/04-apply-release-finalize-runner/04-UAT.md (Test #2)
 * @see .planning/phases/04-apply-release-finalize-runner/04-REVIEW-FIX.md
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { runUnguarded } from '../../../src/guard/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { type ApplyTestTableSetup, setupApplyTestTable } from './_helpers.js';

// ---------------------------------------------------------------------------
// Test config — verbatim copy from apply-happy-path-1k.test.ts
// (acquireWaitMs: 500 > cacheTtlMs: 100 satisfies the load-bearing invariant).
// ---------------------------------------------------------------------------

const testConfig = {
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  migrations: 'src/database/migrations',
  entities: ['src/database/entities'],
  tableName: '', // overridden by tableName arg to createMigrationsClient
  region: undefined,
  remote: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as never;

// ---------------------------------------------------------------------------
// normalizeReads — accept the half-dozen shapes the AWS SDK / ElectroDB stack
// can return for an attribute declared `{ type: 'set', items: 'string' }`:
//
//   - `undefined` / `null`     → undefined (attribute absent on row)
//   - empty `Set<string>`      → undefined (treat empty set as absence)
//   - `Set<string>` with items → sorted string[] (deterministic)
//   - empty `string[]`         → undefined
//   - `string[]` with items    → sorted string[]
//   - `{ wrapperName: 'Set', values: string[] }` (legacy doc-client wrap)
//                              → sorted string[] | undefined per length
//
// Returning a sorted array makes assertions order-independent.
// ---------------------------------------------------------------------------

function normalizeReads(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Set) {
    const arr = [...(value as Set<string>)];
    return arr.length === 0 ? undefined : arr.slice().sort();
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : (value as string[]).slice().sort();
  }
  // Defensive: ElectroDB / AWS SDK sometimes round-trips sets as
  // { wrapperName: 'Set', values: [...] } when marshalling through certain
  // middleware layers. Handle that shape too so the assertion is stable
  // across SDK minor-version drift.
  const v = value as { wrapperName?: string; values?: unknown };
  if (v.wrapperName === 'Set' && Array.isArray(v.values)) {
    const values = v.values as string[];
    return values.length === 0 ? undefined : values.slice().sort();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Suite 1 — full-feature migration: hasDown / hasRollbackResolver / reads
// must all be present on the audit row.
// ---------------------------------------------------------------------------

describe('BL-01 gap closure: full-feature migration audit-row shape', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      setup = await setupApplyTestTable({ recordCount: 5 });
    }
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      // runUnguarded: createMigrationsClient attaches guard middleware to the
      // shared docClient stack; cleanup uses the same raw client and would
      // otherwise be blocked by the guard.
      await runUnguarded(() => setup.cleanup());
    }
  });

  it("writes _migrations row with fingerprint='', kind='transform', hasDown/hasRollbackResolver/reads populated", async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Suppress the RUN-09 stderr summary — not the focus of this test.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // Build the full-feature migration INLINE: spread the bare fixture and
      // add the three optional fields. Distinct id keeps the audit row
      // unambiguous for trace clarity. `reads: [setup.v2Entity]` declares one
      // cross-entity read whose `model.entity === 'User'`.
      const fullFeatureMigration = {
        ...setup.migration,
        id: 'gap-04-15-User-add-status-full',
        down: async (record: unknown) => {
          // Strip `status` on revert. Body is irrelevant — presence is what's
          // tested (sets `migration.down !== undefined` so the conditional
          // spread emits `hasDown: true`).
          const { status: _status, ...rest } = record as Record<string, unknown>;
          return rest;
        },
        rollbackResolver: () => null,
        reads: [setup.v2Entity],
      } as typeof setup.migration & {
        down: (record: unknown) => Promise<unknown>;
        rollbackResolver: () => null;
        reads: ReadonlyArray<unknown>;
      };

      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migrations: [fullFeatureMigration],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.migId).toBe(fullFeatureMigration.id);

      const row = (await runUnguarded(() => setup.service.migrations.get({ id: fullFeatureMigration.id }).go())) as { data: Record<string, unknown> | null };

      expect(row.data).not.toBeNull();
      const r = row.data as Record<string, unknown>;

      // BL-01 audit-row shape — full-feature case.
      expect(r.fingerprint).toBe('');
      expect(r.kind).toBe('transform');
      expect(r.hasDown).toBe(true);
      expect(r.hasRollbackResolver).toBe(true);
      expect(normalizeReads(r.reads)).toEqual(['User']);
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Suite 2 — bare migration: hasDown / hasRollbackResolver / reads must all
// be ABSENT on the audit row (conditional spreads skipped).
// ---------------------------------------------------------------------------

describe('BL-01 gap closure: bare migration audit-row shape', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      setup = await setupApplyTestTable({ recordCount: 5 });
    }
  }, 60_000);

  afterAll(async () => {
    if (alive && setup) {
      await runUnguarded(() => setup.cleanup());
    }
  });

  it("writes _migrations row with fingerprint='', kind='transform', and hasDown/hasRollbackResolver/reads ABSENT (conditional spreads skipped)", async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // setup.migration as-shipped has no `down`, no `rollbackResolver`, no
      // `reads` — exercises the FALSE branch of all three conditional spreads
      // in applyFlowScanWrite's put().
      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migrations: [setup.migration],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.migId).toBe(setup.migration.id);

      const row = (await runUnguarded(() => setup.service.migrations.get({ id: setup.migration.id }).go())) as { data: Record<string, unknown> | null };

      expect(row.data).not.toBeNull();
      const r = row.data as Record<string, unknown>;

      // BL-01 audit-row shape — bare case.
      expect(r.fingerprint).toBe('');
      expect(r.kind).toBe('transform');
      expect(r.hasDown).toBeUndefined();
      expect(r.hasRollbackResolver).toBeUndefined();
      expect(normalizeReads(r.reads)).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});
