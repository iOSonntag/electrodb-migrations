---
phase: 04-apply-release-finalize-runner
reviewed: 2026-05-09T00:00:00Z
depth: standard
files_reviewed: 1
files_reviewed_list:
  - tests/integration/runner/apply-audit-row-shape.test.ts
findings:
  blocker: 0
  warning: 3
  total: 3
status: issues_found
---

# Phase 4: Code Review Report (Gap-Closure Cycle)

**Reviewed:** 2026-05-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 1
**Status:** issues_found

## Summary

This is a gap-closure review covering the single new file produced by plan 04-15: an integration regression test that pins the BL-01 fix (`_migrations` audit-row shape after a single `applyFlowScanWrite` put). All earlier phase-04 findings (WR-01..WR-11) were resolved on `main` in commits `76caad8`, `50f2a91`, `9b1df84`, `6737214`, and `f8f8405`; this REVIEW.md replaces the prior one (the prior findings remain preserved in git history).

The test correctly exercises the BL-01 invariant: after a full-feature apply, `fingerprint=''`, `kind='transform'`, `hasDown=true`, `hasRollbackResolver=true`, and `reads` deserializes to `['User']`; after a bare apply, the three optional fields are absent. Two `describe` blocks each provision an isolated ephemeral DDB Local table, run all read-backs through `runUnguarded`, and inline a `normalizeReads` helper that absorbs the AWS SDK / ElectroDB set-shape variance.

**No BLOCKER issues found.** The assertions match the source contract in `applyFlowScanWrite` (lines 119-135 of `src/runner/apply-flow.ts`): conditional spreads only emit `hasDown` / `hasRollbackResolver` / `reads` when their source fields are present and (for `reads`) non-empty; the test verifies both branches. The `Migration` type at `src/migrations/types.ts` confirms the bare fixture (`createUserAddStatusMigration`) ships without `down`, `rollbackResolver`, or `reads` — Suite 2's "all absent" expectations are sound. `runUnguarded` is correctly used both for the post-apply read-back (the `createMigrationsClient` call attaches guard middleware to the shared docClient stack) and for the `afterAll` cleanup. The `acquireWaitMs > cacheTtlMs` invariant holds in `testConfig` (500 > 100).

The findings below are quality concerns: none affect the BL-01 regression coverage, but each will degrade maintenance over time if a future BL-01-adjacent change touches this file.

## Warnings

### WR-01: Duplicate beforeAll/afterAll/spy wiring across two describe blocks

**File:** `tests/integration/runner/apply-audit-row-shape.test.ts:101-179, 186-241`
**Issue:** The two `describe` blocks (full-feature and bare) duplicate verbatim:
- The `let alive = false; let setup: ApplyTestTableSetup;` declarations
- The `beforeAll` body (`isDdbLocalReachable` + `setupApplyTestTable({ recordCount: 5 })`)
- The `afterAll` body (`runUnguarded(() => setup.cleanup())`)
- The `if (!alive) { console.warn(skipMessage()); return; }` early return
- The `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)` setup-and-restore in `try/finally`
- The post-apply read pattern (`runUnguarded(() => setup.service.migrations.get({ id }).go())`)

If a future maintainer needs to update the suppression / skip / runUnguarded pattern (for example to also suppress stdout, or to call `release()` between apply and cleanup), they have to update both blocks and the diff is silent on a missed copy. The two cases differ in roughly 12 lines (the inline migration construction and the three `expect(...)` lines per case) — everything else should live in a shared helper or a `describe.each(...)`.

**Fix:** Extract a `runAuditRowShapeCase` helper that takes a migration-builder closure plus an assertion closure, or use `describe.each`:
```ts
describe.each([
  {
    label: 'full-feature migration',
    buildMigration: (setup: ApplyTestTableSetup) => ({
      ...setup.migration,
      id: 'gap-04-15-User-add-status-full',
      down: async (record: unknown) => {
        const { status: _status, ...rest } = record as Record<string, unknown>;
        return rest;
      },
      rollbackResolver: () => null,
      reads: [setup.v2Entity],
    }),
    expectShape: (r: Record<string, unknown>) => {
      expect(r.hasDown).toBe(true);
      expect(r.hasRollbackResolver).toBe(true);
      expect(normalizeReads(r.reads)).toEqual(['User']);
    },
  },
  {
    label: 'bare migration',
    buildMigration: (setup: ApplyTestTableSetup) => setup.migration,
    expectShape: (r: Record<string, unknown>) => {
      expect(r.hasDown).toBeUndefined();
      expect(r.hasRollbackResolver).toBeUndefined();
      expect(normalizeReads(r.reads)).toBeUndefined();
    },
  },
])('BL-01 gap closure: $label audit-row shape', ({ buildMigration, expectShape }) => {
  // ... single beforeAll / afterAll / it body ...
});
```

### WR-02: Type assertion on `fullFeatureMigration` weakens `reads` from AnyElectroEntity to unknown

**File:** `tests/integration/runner/apply-audit-row-shape.test.ts:147-151`
**Issue:** The inline migration is cast to:
```ts
} as typeof setup.migration & {
  down: (record: unknown) => Promise<unknown>;
  rollbackResolver: () => null;
  reads: ReadonlyArray<unknown>;
};
```
But the contract in `src/migrations/types.ts:43` is `reads?: ReadonlyArray<AnyElectroEntity>`. By widening to `ReadonlyArray<unknown>` the test silently allows a future change to pass non-entities into `reads`, at which point the `.map((e) => e.model.entity)` projection inside `applyFlowScanWrite` (apply-flow.ts:131-132) crashes with a runtime `TypeError: Cannot read properties of undefined (reading 'entity')`. The test would still pass against the production type since `setup.v2Entity` IS an ElectroDB entity, but the test's local type erodes the very invariant it depends on.

The `rollbackResolver: () => null` typing also narrows the parameter list from `(...args: unknown[]) => unknown` to `() => null`. The inferred type is assignable in the `&` direction (more specific), but it doesn't model what the runner sees and may mask a future signature change.

**Fix:** Either drop the entire ad-hoc intersection and let the `defineMigration<UserV1, UserV2>` generic carry the typing, or import `AnyElectroEntity` and use it directly:
```ts
import type { AnyElectroEntity } from '../../../src/migrations/types.js';

// ...
} as typeof setup.migration & {
  down: (record: unknown) => Promise<unknown>;
  rollbackResolver: (...args: unknown[]) => unknown;
  reads: ReadonlyArray<AnyElectroEntity>;
};
```
Better yet, build the migration via `defineMigration({ ...setup.migration, id, down, rollbackResolver, reads: [setup.v2Entity] })` so the framework's own factory enforces the contract.

### WR-03: `as never` on testConfig bypasses all type-checking on the framework's config surface

**File:** `tests/integration/runner/apply-audit-row-shape.test.ts:47-58`
**Issue:** The `testConfig` literal ends with `as never`, which is the strongest possible type assertion — it tells TypeScript "trust me, this fits any context" and disables shape-checking against the actual `ResolvedConfig` type that `createMigrationsClient` consumes. If Phase 5+ adds a required field (for example a rollback-strategy default) or renames an existing one (for example `acquireWaitMs` → `acquireMaxWaitMs`), this test will keep compiling and pass through silent bad config until the runtime validation catches it (or doesn't).

The JSDoc comment "verbatim copy from apply-happy-path-1k.test.ts" documents the duplication but doesn't justify the `as never` — the original sibling file uses the same anti-pattern, so the smell is propagating across the suite. This is a pre-existing project pattern, but it's reasonable to flag it on every new addition because each new copy raises the cost of fixing the typing later.

**Fix:** Either type the constant against the public config surface and remove the cast, or — if the real `ResolvedConfig` is intentionally generated (Phase 5/6 work) — extract this literal into `tests/integration/runner/_helpers.ts` as a single typed `export const APPLY_TEST_CONFIG` so there's exactly one place to fix when the typing tightens:
```ts
// in _helpers.ts
import type { ResolvedConfig } from '../../../src/config/types.js';
export const APPLY_TEST_CONFIG: ResolvedConfig = { /* ... */ };

// in this test
import { APPLY_TEST_CONFIG } from './_helpers.js';
```

---

_Reviewed: 2026-05-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
