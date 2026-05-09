---
phase: 06
plan: 02
subsystem: ctx
tags:
  - ctx
  - facade
  - phase-06
  - wave-1
dependency_graph:
  requires:
    - src/migrations/types.ts (AnyElectroEntity type)
    - electrodb (Entity constructor — peer dep)
    - "@aws-sdk/lib-dynamodb (DynamoDBDocumentClient type — dev dep)"
    - tests/unit/ctx/_helpers.ts (Plan 06-01 shared helpers, not directly imported but context)
    - tests/unit/ctx/read-only-facade.test.ts (Plan 06-01 RED tests — flipped to GREEN)
    - tests/unit/ctx/entity-clone.spike.test.ts (Plan 06-01 spike — regression checked)
    - tests/unit/ctx/source-scan.test.ts (Plan 06-01 invariant — still GREEN)
  provides:
    - src/ctx/types.ts (MigrationCtx + ReadOnlyEntityFacade<E> public type definitions)
    - src/ctx/read-only-facade.ts (createReadOnlyFacade utility + ReadOnlyFacadeRuntime type)
  affects:
    - Plan 06-03 (buildCtx imports createReadOnlyFacade from this plan's output)
    - Plan 06-06 (integration tests consume the facade via buildCtx)
tech_stack:
  added: []
  patterns:
    - New Entity(schema, config) clone strategy for read-only facade (Pitfall 1 safe — no setClient mutation)
    - Direct property reference for ElectroDB namespace objects (query/scan — Pitfall 2 safe)
    - makeWriteThrow factory for DRY write traps with method-specific error messages
    - () => never typing for write methods (compile-time + runtime defense in depth)
key_files:
  created:
    - src/ctx/types.ts
    - src/ctx/read-only-facade.ts
  modified:
    - tests/unit/ctx/read-only-facade.test.ts (removed @ts-expect-error on import; GREEN flip)
decisions:
  - "Write methods typed as () => never (not bare `never`) for clearer call-site TypeScript errors per RESEARCH §Code Examples line 657"
  - "batchGet omitted from facade type and runtime — deferred to Phase 8 per PATTERNS line 87"
  - "src/ctx/index.ts NOT created — barrel deferred to Plan 06-03 to avoid intra-wave file conflict"
  - "makeWriteThrow throws plain Error (not EDB* class) per RESEARCH Anti-Patterns line 529 — write traps are programming errors, not runtime DDB errors"
metrics:
  duration_minutes: 3
  tasks_completed: 2
  files_created: 2
  files_modified: 1
  completed_date: "2026-05-09"
---

# Phase 06 Plan 02: Read-Only Facade Summary

**One-liner:** createReadOnlyFacade using new Entity(schema, config) clone strategy — 6 read methods passthrough, 7 write traps throw [electrodb-migrations] Error; CTX-02 + CTX-03 unit tests flipped to GREEN.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Define MigrationCtx + ReadOnlyEntityFacade types | fa70524 | src/ctx/types.ts |
| 2 | Implement createReadOnlyFacade; flip RED tests to GREEN | 54d48d1 | src/ctx/read-only-facade.ts, tests/unit/ctx/read-only-facade.test.ts |

## File Delta

3 files changed (plan target: 2 src + 1 test flip):
- 2 files created: `src/ctx/types.ts`, `src/ctx/read-only-facade.ts`
- 1 file modified: `tests/unit/ctx/read-only-facade.test.ts` (removed `@ts-expect-error`; GREEN flip)
- 0 files created unexpectedly

**Barrel `src/ctx/index.ts` was NOT touched** — deferred to Plan 06-03 to prevent intra-wave file conflict. The facade is consumable via direct import: `import { createReadOnlyFacade } from '../ctx/read-only-facade.js'`.

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm tsc --noEmit` | PASS |
| `pnpm test tests/unit/ctx/read-only-facade.test.ts` (9/9) | PASS — all RED tests GREEN |
| `pnpm test tests/unit/ctx/source-scan.test.ts` (2/2) | PASS — no setClient in src/ctx/ |
| `pnpm test tests/unit/ctx/entity-clone.spike.test.ts` (4/4) | PASS — regression clean |
| `src/ctx/index.ts` not created | PASS — barrel deferred to 06-03 |

## CTX Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| CTX-02: facade exposes read methods bound to unguarded client + table | UNIT GREEN | `facade.get({id}).params().TableName === 'facade-table'` test passes |
| CTX-03: write methods throw before any DDB call | UNIT GREEN | 7 `it.each` write-method throw tests pass; plain `Error` with `[electrodb-migrations]` prefix |

## Architecture Decisions

### Write method typing: `() => never` vs bare `never`
Typed write methods as `() => never` rather than bare `never`. This means calling `facade.put({...})` produces a TypeScript error at the call site (the return type `never` is not assignable to anything). Bare `never` as a property type would give "property does not exist" style errors in some IDE setups, which can be more confusing. The `() => never` approach provides clearer diagnostics.

### batchGet omitted
`batchGet` is not included in `ReadOnlyEntityFacade<E>` or the runtime facade. PATTERNS line 87 documents this as a Phase 8 concern — ElectroDB's `batchGet` return type inference is complex across versions and tightening it would block Phase 8 inference work unnecessarily for v0.1.

### makeWriteThrow factory
7 write traps are produced by a single `makeWriteThrow(method: string)` factory function. Each trap includes the method name in the error message (`ctx.entity().put()`) so operators can immediately identify which write was attempted. Error message also includes `[electrodb-migrations]` prefix consistent with `src/runner/apply-flow.ts` conventions.

## Pitfalls Avoided

| Pitfall | How Avoided |
|---------|-------------|
| Pitfall 1: setClient mutation | `new Entity((entity as any).schema, { client, table })` — never calls setClient; source-scan invariant enforces this at build time |
| Pitfall 2: query/scan binding | `query: boundEntity.query`, `scan: boundEntity.scan` — direct property reference, NOT `.bind(boundEntity)` |

## Source-Scan Invariant

`tests/unit/ctx/source-scan.test.ts` passes: no `entity.setClient(` calls exist under `src/ctx/`. The invariant was armed at Wave 0 (Plan 06-01) and remains GREEN after Wave 1 file additions.

## No Known Stubs

No hardcoded empty values, placeholder text, or unwired data sources. The facade is fully functional: read methods delegate to the cloned entity, write traps throw immediately.

## Threat Surface Scan

No new network endpoints or auth paths introduced. The facade is a pure in-process wrapper — all DDB calls route through the existing `DynamoDBDocumentClient` provided by the caller. No threat flags.

## Threat Model Mitigations Applied

| Threat ID | Mitigation Applied |
|-----------|-------------------|
| T-06-02-01 | `new Entity(schema, config)` clone — setClient never called; source-scan enforces at build time |
| T-06-02-03 | `makeWriteThrow(method)` includes method name in error message |
| T-06-02-04 | `query: boundEntity.query` (no `.bind`) — acceptance criterion grep confirmed |

T-06-02-02 is accepted (static allowlist is fail-closed for unknown future write methods).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified:
- src/ctx/types.ts: FOUND
- src/ctx/read-only-facade.ts: FOUND

Commits verified:
- fa70524 (types.ts — MigrationCtx + ReadOnlyEntityFacade)
- 54d48d1 (read-only-facade.ts + GREEN flip)
