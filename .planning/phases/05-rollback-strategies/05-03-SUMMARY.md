---
phase: 05-rollback-strategies
plan: 03
subsystem: rollback
tags:
  - rollback
  - type-table
  - identity-stamp
  - tdd
  - phase-05
  - wave-1
  - rbk-04
  - rbk-11
dependency_graph:
  requires:
    - tests/_helpers/sample-migrations/User-add-status-with-down/
    - tests/_helpers/sample-migrations/User-and-Team-std/
    - tests/integration/rollback/setupRollbackTestTable
    - tests/unit/rollback/makeRollbackStubService
    - src/safety/index.ts (CONSISTENT_READ)
    - src/migrations/types.ts (AnyElectroEntity, Migration)
  provides:
    - src/rollback/identity-stamp.ts (classifyOwner, extractDomainKey)
    - src/rollback/type-table.ts (classifyTypeTable, TypeTableEntry, TypeTableCounts)
    - src/rollback/index.ts (rollback barrel)
    - tests/unit/rollback/identity-stamp.test.ts
    - tests/unit/rollback/type-table.test.ts
    - tests/integration/rollback/std-classify.test.ts (RBK-11 load-bearing gate)
  affects:
    - tests/unit/lock/source-scan.test.ts (removed src/rollback/ toBe(false) sentinel)
tech_stack:
  added: []
  patterns:
    - Two-scan union AsyncGenerator (Phase 1 index v1 Map + Phase 2 stream v2 + Phase 3 emit C)
    - Pure identity-stamp utilities using ElectroDB internal API (ownsItem + schema.indexes.byId.pk.composite)
    - CONSISTENT_READ named import on every scan call (source-scan invariant)
    - User-domain attribute access from entity.scan.go() output (already-parsed shape, not raw DDB Items)
key_files:
  created:
    - src/rollback/identity-stamp.ts
    - src/rollback/type-table.ts
    - src/rollback/index.ts
    - tests/unit/rollback/identity-stamp.test.ts
    - tests/unit/rollback/type-table.test.ts
    - tests/integration/rollback/std-classify.test.ts
  modified:
    - tests/unit/lock/source-scan.test.ts
decisions:
  - "extractDomainKey reads composite attribute values directly from entity.scan.go() output (already user-domain shape) — NOT via entity.parse({Item: record}) which is for raw marshalled DDB Items"
  - "Refactor (paginate helper) skipped — Phase 1 (accumulate Map) and Phase 2 (yield + seen set) have fundamentally different inner bodies; extracting a paginate helper adds noise without reducing lines"
  - "TypeTableCounts defined now (not consumed by this plan) so Plan 05-06 snapshot strategy can import without re-export friction"
metrics:
  duration_minutes: 35
  completed_date: "2026-05-09"
  tasks_completed: 5
  tasks_total: 5
  files_created: 6
  files_modified: 1
---

# Phase 5 Plan 03: Type-Table Classifier with STD Safety (Wave 1) Summary

Identity-stamp utilities (`classifyOwner`, `extractDomainKey`) plus the `classifyTypeTable` AsyncGenerator implementing RBK-04 four-cell classification (A/B/C/D) with RBK-11 STD safety proven by integration test against DDB Local.

## What Was Built

### Feature 1: `classifyOwner` (pure, identity-stamp check)

Delegates to ElectroDB's `entity.ownsItem(record)` which checks `__edb_e__` AND `__edb_v__` stamps. A Team record on the same STD table returns `null` — the cross-entity safety is built into ElectroDB's API.

- Source-verified: `.research/electrodb/src/entity.js:146-154`
- 5 unit test cases: v1-owned, v2-owned, Team record → null, missing stamps → null, empty record → null

### Feature 2: `extractDomainKey` (pure, PK composite projection)

**Key implementation insight:** ElectroDB's `entity.scan.go()` returns records in user-domain shape (pk/sk bytes and `__edb_e__`/`__edb_v__` stamps are absent). Composite attribute values are accessible directly on the record — `entity.parse({Item: record})` is NOT called (that API is for raw DDB marshalled items from GetItem). This fixes a null-data bug where `entity.parse` returned `{data: null}` on scan output.

- Reads `entity.schema.indexes.byId.pk.composite` + projects directly from record
- 4 unit test cases: single-composite, v1/v2 same key, multi-field composite, not-from-pk-bytes

### Feature 3: `classifyTypeTable` AsyncGenerator (RBK-04 + RBK-11)

Three-phase two-scan union:
1. **Phase 1 (index v1):** Scan `migration.from` → build `Map<domainKey, v1Record>`.
2. **Phase 2 (stream v2):** Scan `migration.to` → for each record: emit Type A (in Map) or Type B (not in Map); track `seen` Set.
3. **Phase 3 (emit C):** Iterate v1Index; keys not in `seen` → emit Type C.

Type D unreachable by construction.

**CONSISTENT_READ:** Named import passed to every scan call — source-scan invariant enforced.

**Memory floor (RESEARCH OQ5 disposition):** `v1Index` Map holds O(v1-record-count) entries in memory between Phase 1 and Phase 3. Accepted for v0.1; deferred to v0.2 for streaming-interleaved optimization.

**STD safety (RBK-11):** Each `entity.scan` filters by `__edb_e__`/`__edb_v__`. Team records are invisible to User's classifier by construction.

- 8 unit test cases: empty, C-only, B-only, A-only, A+B mix, A+C mix, multi-page, consistent check
- Integration test: 3A+2B+2C User records + 5 Team records → 7 entries emitted, 0 Team entries

### Barrel `src/rollback/index.ts`

Re-exports `classifyOwner`, `extractDomainKey`, `classifyTypeTable`, `TypeTableEntry`, `TypeTableCounts`, `ClassifyTypeTableArgs`. Named exports only.

### Source-scan sentinel update

Removed `expect(files.some(f => f.includes('src/rollback/'))).toBe(false)` — Plan 05-03 introduces the first `src/rollback/` files. Source-scan invariants (CONSISTENT_READ, no setInterval, no inline `consistent: true`) now auto-enforce across `src/rollback/` via the existing glob.

## Requirement Coverage

| Requirement | Level | Evidence |
|------------|-------|---------|
| RBK-04 (A/B/C/D classification) | Unit + Integration | 8 unit cases + STD integration test cover all cell types |
| RBK-11 (STD safety) | Integration | `std-classify.test.ts` — 5 Team records invisible to User classifier |

## STD Integration Test Outcome

**PASS** — DDB Local was reachable. 3 tests passed:
- `classifier emits exactly 7 entries (3 A + 2 B + 2 C)` — PASS
- `no entry contains Team-shaped data (teamLabel field)` — PASS
- `Team records in the table are unchanged after classification (classifier is read-only)` — PASS

## Memory-Floor Disposition

Per RESEARCH OQ5: The `v1Index` Map holds ~O(v1-record-count) entries in memory between Phase 1 and Phase 3. For a 1M-record table at 2KB/record this is ~2GB. This is accepted as the v0.1 operational floor (single-developer dogfooding). The v0.2 path is streaming-interleaved scans. Documented in `classifyTypeTable` JSDoc.

## Test Results

- `pnpm tsc --noEmit`: PASS (0 errors)
- `pnpm vitest run tests/unit/rollback/`: 17/17 PASS
- `pnpm vitest run tests/unit/lock/source-scan.test.ts`: 3/3 PASS
- `pnpm vitest run -c vitest.integration.config.ts tests/integration/rollback/std-classify.test.ts`: 3/3 PASS

## Commits

| Task | Hash | Description |
|------|------|-------------|
| RED (identity-stamp) | 7234065 | test(05-03): RED — failing tests for classifyOwner + extractDomainKey |
| GREEN (identity-stamp) | 5478243 | feat(05-03): GREEN — identity-stamp utilities (RBK-11) |
| RED (type-table + STD) | b2dbc68 | test(05-03): RED — failing tests for classifyTypeTable + STD integration |
| GREEN (type-table) | e6e12b5 | feat(05-03): GREEN — type-table classifier per RBK-04 + STD safety |
| Barrel + source-scan | 791454e | feat(05-03): barrel src/rollback/index.ts + update source-scan sentinel |
| TS fix | 7394bac | fix(05-03): use explicit TypeTableEntry type in integration test |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] entity.parse({Item: record}) returns null on scan output**

- **Found during:** Task 4 (GREEN phase for classifyTypeTable integration test)
- **Issue:** `entity.parse({Item: record})` returned `{data: null}` when `record` came from `entity.scan.go()`. ElectroDB's `scan.go()` returns user-domain-shaped data (pk/sk bytes and stamps stripped), but `entity.parse()` expects raw DDB marshalled items with pk/sk. The plan's verbatim spec called `entity.parse` — this was wrong for the scan-data path.
- **Fix:** `extractDomainKey` now reads composite attribute values directly from the record object (the domain attributes are already at the top level in scan output). Added a comment explaining the distinction between scan output and raw DDB items.
- **Files modified:** `src/rollback/identity-stamp.ts`, `tests/unit/rollback/identity-stamp.test.ts` (description update)
- **Commit:** e6e12b5

**2. [Rule 1 - Bug] Test used complex infer type expression that resolved to `never`**

- **Found during:** `pnpm tsc --noEmit` after creating integration test
- **Issue:** `Awaited<ReturnType<typeof classifyTypeTable extends AsyncGenerator<infer T> ? () => T : never>>[]` did not resolve as expected, causing TypeScript to infer `never` for array element type.
- **Fix:** Import `TypeTableEntry` directly and use `TypeTableEntry[]` as the array type.
- **Files modified:** `tests/integration/rollback/std-classify.test.ts`
- **Commit:** 7394bac

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (identity-stamp) | 7234065 | PASS — import failure confirms test was failing |
| GREEN (identity-stamp) | 5478243 | PASS — 9/9 tests pass |
| RED (type-table) | b2dbc68 | PASS — import failure confirms test was failing |
| GREEN (type-table) | e6e12b5 | PASS — 8/8 unit + 3/3 integration tests pass |

## Known Stubs

None.

## Threat Flags

No new threat surface beyond what the plan's threat model documents (T-05-03-01 through T-05-03-05 all handled — STD mis-classification prevented by ElectroDB identity-stamp filtering + integration test; CONSISTENT_READ enforced on every scan; memory floor documented; OQ6 PK-composite divergence deferred to Phase 7).

## Self-Check: PASSED
