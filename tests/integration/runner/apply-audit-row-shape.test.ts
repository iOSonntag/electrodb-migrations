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
import type { AnyElectroEntity, RollbackResolverArgs } from '../../../src/migrations/types.js';
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
// Suite cases — full-feature and bare migration share identical
// beforeAll/afterAll/spy/runUnguarded plumbing; only the inline migration
// construction and the three flag-shape assertions differ. `describe.each`
// consolidates the wiring so a future maintainer who needs to update the
// suppression / skip / runUnguarded pattern (e.g. to also suppress stdout, or
// to call `release()` between apply and cleanup) edits exactly one place.
// ---------------------------------------------------------------------------

interface AuditRowShapeCase {
  /** Sub-suite label rendered into the describe.each title via $label. */
  label: string;
  /**
   * Build the migration to apply. Must return a migration whose `id` is unique
   * to the case so the audit-row read-back is unambiguous.
   *
   * The return type is `setup.migration & {...}` because the full-feature
   * variant adds three optional fields that the bare fixture omits; the
   * intersection is widened just enough to admit both shapes. Each optional
   * field mirrors the framework contract on `Migration` at
   * `src/migrations/types.ts` exactly (rather than a looser `unknown`-leaning
   * shape). Typing `reads` as `ReadonlyArray<AnyElectroEntity>` rather than
   * `ReadonlyArray<unknown>` ensures a future refactor that passes
   * non-entities here fails at type-check time instead of crashing at runtime
   * inside `applyFlowScanWrite`'s `.map(e => e.model.entity)` projection.
   */
  buildMigration: (setup: ApplyTestTableSetup) => ApplyTestTableSetup['migration'] & {
    down?: (record: unknown, ctx?: unknown) => Promise<unknown>;
    rollbackResolver?: (args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>;
    reads?: ReadonlyArray<AnyElectroEntity>;
  };
  /** Assert the three case-specific flag/reads shapes on the read-back row. */
  expectShape: (row: Record<string, unknown>) => void;
}

const cases: ReadonlyArray<AuditRowShapeCase> = [
  {
    label: 'full-feature migration',
    buildMigration: (setup) =>
      ({
        ...setup.migration,
        id: 'gap-04-15-User-add-status-full',
        down: async (record: unknown) => {
          // Strip `status` on revert. Body is irrelevant — presence is what's
          // tested (sets `migration.down !== undefined` so the conditional
          // spread emits `hasDown: true`).
          const { status: _status, ...rest } = record as Record<string, unknown>;
          return rest;
        },
        rollbackResolver: async (_args: RollbackResolverArgs) => null,
        reads: [setup.v2Entity],
      }) as typeof setup.migration & {
        down: (record: unknown, ctx?: unknown) => Promise<unknown>;
        rollbackResolver: (args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>;
        reads: ReadonlyArray<AnyElectroEntity>;
      },
    expectShape: (r) => {
      expect(r.hasDown).toBe(true);
      expect(r.hasRollbackResolver).toBe(true);
      expect(normalizeReads(r.reads)).toEqual(['User']);
    },
  },
  {
    label: 'bare migration',
    // setup.migration as-shipped has no `down`, no `rollbackResolver`, no
    // `reads` — exercises the FALSE branch of all three conditional spreads
    // in applyFlowScanWrite's put().
    buildMigration: (setup) => setup.migration,
    expectShape: (r) => {
      expect(r.hasDown).toBeUndefined();
      expect(r.hasRollbackResolver).toBeUndefined();
      expect(normalizeReads(r.reads)).toBeUndefined();
    },
  },
];

describe.each(cases)('BL-01 gap closure: $label audit-row shape', ({ buildMigration, expectShape }) => {
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

  it("writes _migrations row with fingerprint='', kind='transform', and the case-specific hasDown/hasRollbackResolver/reads shape", async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    // Suppress the RUN-09 stderr summary — not the focus of this test.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const migration = buildMigration(setup);

      const client = createMigrationsClient({
        config: testConfig,
        client: setup.doc,
        tableName: setup.tableName,
        migrations: [migration],
      });

      const result = await client.apply();
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]?.migId).toBe(migration.id);

      const row = (await runUnguarded(() => setup.service.migrations.get({ id: migration.id }).go())) as {
        data: Record<string, unknown> | null;
      };

      expect(row.data).not.toBeNull();
      const r = row.data as Record<string, unknown>;

      // BL-01 audit-row shape — invariant fields shared by both cases.
      expect(r.fingerprint).toBe('');
      expect(r.kind).toBe('transform');

      // Case-specific flag/reads shape.
      expectShape(r);
    } finally {
      stderrSpy.mockRestore();
    }
  }, 60_000);
});
