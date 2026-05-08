---
phase: 04-apply-release-finalize-runner
plan: 04
subsystem: runner

tags: [runner, discovery, jiti, sequence-enforcement, phase-04, wave-1, tdd]

# Dependency graph
requires:
  - phase: 01-foundation-safety-primitives
    provides: EDBMigrationError base class (errors/base.ts), jiti pattern (config/load.ts)
  - phase: 04-apply-release-finalize-runner
    plan: 01
    provides: Sample-migration fixture infrastructure (User-add-status), runner stub service

provides:
  - src/runner/load-migration-module.ts: EDBMigrationLoadError + loadMigrationFile (jiti-based)
  - src/runner/load-pending.ts: loadPendingMigrations + isNextPending + PendingMigration type
  - tests/_helpers/sample-migrations/User-add-status/: v1/v2/migration/index fixture
  - tests/_helpers/sample-migrations/User-add-tier/: v1(UserV2)/v2(UserV3)/migration/index fixture
  - tests/unit/runner/_stub-service.ts: makeRunnerStubService with setScanPages API
  - tests/unit/runner/load-pending.test.ts: 12 unit tests (3 LM + 5 LP + 4 NP)

affects:
  - 04-08 (apply-flow): consumes loadPendingMigrations + isNextPending for pre-lock pending check
  - 04-12 (apply-CLI): calls loadPendingMigrations before acquireLock for RUN-07 short-circuit

# Tech tracking
tech-stack:
  added:
    - none (jiti already in dependencies; no new packages)
  patterns:
    - "jiti createJiti(import.meta.url, { tryNative: true }) + jiti.import(path) pattern mirrors config/load.ts"
    - "vi.mock hoisted at module level + per-test mockResolvedValueOnce for deterministic disk-side LP tests"
    - "vi.importActual for LM tests that need the real jiti implementation"
    - "makeRunnerStubService with closure-based setScanPages for scan.go result injection"
    - "Per-entity isNextPending: filter by entityName first, check first in filtered list"

key-files:
  created:
    - src/runner/load-migration-module.ts
    - src/runner/load-pending.ts
    - tests/_helpers/sample-migrations/User-add-status/v1.ts
    - tests/_helpers/sample-migrations/User-add-status/v2.ts
    - tests/_helpers/sample-migrations/User-add-status/migration.ts
    - tests/_helpers/sample-migrations/User-add-status/index.ts
    - tests/_helpers/sample-migrations/User-add-tier/v1.ts
    - tests/_helpers/sample-migrations/User-add-tier/v2.ts
    - tests/_helpers/sample-migrations/User-add-tier/migration.ts
    - tests/_helpers/sample-migrations/User-add-tier/index.ts
    - tests/unit/runner/_stub-service.ts
    - tests/unit/runner/load-pending.test.ts
  modified:
    - src/migrations/index.ts (additive: export AnyElectroEntity alongside Migration)

key-decisions:
  - "OQ-4 disposition: runner discovers from disk (not _migrations rows) — preserves Phase 2 file-system-only contract"
  - "OQ-6 disposition: isNextPending is per-entity — cross-entity ordering is Phase 7 validate (VAL-05)"
  - "LP tests use vi.mock hoisting + per-test mockResolvedValueOnce rather than temp-dir approach to avoid Team-entity fixtures not in plan scope"
  - "LP-1 invariant: readdir failure → catch → return [] without calling scan.go (scan never touches DDB for empty/missing dirs)"
  - "T-04-04-04 mitigation: failed status excluded from pending — LP-5 enforces operator must run rollback first"

# Metrics
duration: ~10min
completed: 2026-05-08
---

# Phase 4 Plan 04: Migration Discovery + Sequence Enforcement Summary

**jiti-based migration loader (EDBMigrationLoadError) + disk-discovery/correlation module (loadPendingMigrations + isNextPending) with per-entity sequence enforcement — implements RUN-06 and RUN-07 via 12 unit tests across 3 test surfaces.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-08T18:45:29Z
- **Completed:** 2026-05-08T18:54:48Z
- **Tasks:** 1 (TDD plan — RED + GREEN + fixture creation)
- **Files created:** 12
- **Files modified:** 1 (src/migrations/index.ts — additive AnyElectroEntity export)
- **Test commits:** 2 (`fb2d8b5` RED, `63ad361` GREEN)

## Accomplishments

- `loadMigrationFile(path)` mirrors the jiti pattern from `src/config/load.ts` exactly: `createJiti(import.meta.url, { tryNative: true })` + `jiti.import(path)`. Errors wrapped in `EDBMigrationLoadError` (internal-only; NOT re-exported from `src/index.ts` per the plan's verification criterion).
- `loadPendingMigrations` implements OQ-4 disposition: discovers from disk, correlates against `_migrations` rows, returns sorted-by-`(entityName, fromVersion)` ascending pending list. Fails-fast on empty/missing directory WITHOUT calling DDB (LP-1 invariant).
- `isNextPending` implements OQ-6 disposition: per-entity scope. Cross-entity ordering is Phase 7's responsibility (VAL-05). NP-4 confirms a migration IS next for its entity even if another entity's migration is earlier in the global list.
- `User-add-tier` fixture (User v2→v3, adds `tier: 'free'|'pro'`) provides the second User migration for sequence-ordering tests (LP-2/LP-4).
- `User-add-status` fixture (User v1→v2, adds `status: 'active'`) created (plan 04-01 work shared by this worktree as prerequisite).
- Runner stub service (`_stub-service.ts`) with `makeRunnerStubService` + `setScanPages` supports deterministic `_migrations` scan results without DDB.

## Test Names (12 tests)

### LM: loadMigrationFile (3 tests)
1. `LM-1: loads real User-add-status/v1.ts and returns module namespace (no default export)`
2. `LM-2: falls back to module namespace when no default export`
3. `LM-3: wraps inner errors in EDBMigrationLoadError with correct code + details`

### LP: loadPendingMigrations (5 tests)
4. `LP-1: empty migrations directory → returns [] without calling scan`
5. `LP-2: two disk migrations, zero _migrations rows → both pending sorted by (entityName, fromVersion)`
6. `LP-3: applied _migrations row for User-add-status → only User-add-tier pending`
7. `LP-4: 4 cross-entity migrations, 0 rows → sorted by (entityName, fromVersion) ascending`
8. `LP-5: failed migration row is NOT pending (requires rollback first)`

### NP: isNextPending (4 tests)
9. `NP-1: empty pending list → false`
10. `NP-2: migId is the first pending of its entity → true`
11. `NP-3: migId is NOT first of its entity (another is ahead) → false`
12. `NP-4: per-entity scope — migId is next FOR ITS ENTITY even if another entity is earlier in global list`

## Module Line Counts

| File | Lines |
|------|-------|
| `src/runner/load-migration-module.ts` | 47 |
| `src/runner/load-pending.ts` | 163 |
| `tests/unit/runner/load-pending.test.ts` | 295 |
| `tests/unit/runner/_stub-service.ts` | 88 |

## User-add-tier Fixture

The `User-add-tier` fixture builds the User v2→v3 migration:
- `v1.ts` exports `createUserV2` — User at version '2' (from: User-add-status's v2 shape; id, name, status, version attributes)
- `v2.ts` exports `createUserV3` — User at version '3' with added `tier: ['free', 'pro'] as const`
- `migration.ts` exports `createUserAddTierMigration` — `defineMigration({ id: '20260701000000-User-add-tier', entityName: 'User', fromVersion: '2'→'3', up: adds tier='free' })`
- `index.ts` barrel — named exports only

The fixture wires `from.model.version = '2'` and `to.model.version = '3'`, ensuring `loadPendingMigrations` correctly extracts `fromVersion='2'` for sort ordering (sorts AFTER User-add-status with `fromVersion='1'`).

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | Failing tests + fixtures + stub service | `fb2d8b5` | 10 files |
| GREEN | Source modules + test revision | `63ad361` | 4 files |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Export] AnyElectroEntity not exported from migrations/index.ts**
- **Found during:** GREEN phase (creating source modules)
- **Issue:** `src/runner/load-migration-module.ts` and `src/runner/load-pending.ts` import `AnyElectroEntity` from `'../migrations/index.js'` (as specified in the plan), but `src/migrations/index.ts` only re-exported `Migration`, not `AnyElectroEntity`.
- **Fix:** Added `AnyElectroEntity` to the exports of `src/migrations/index.ts` (additive, no breaking change).
- **Files modified:** `src/migrations/index.ts`
- **Commit:** `63ad361` (GREEN)

**2. [Rule 3 - Blocking] Plan references runner stub service from plan 04-01 (wave-1 parallel)**
- **Found during:** RED phase setup
- **Issue:** `tests/unit/runner/_stub-service.ts` was to be created by plan 04-01, but as a parallel wave-1 plan, it wasn't available in this worktree.
- **Fix:** Created the runner stub service in this worktree with the `setScanPages` API the LP tests need. The stub is minimal — only the chains used by `loadPendingMigrations` (`migrations.scan.go`).
- **Files modified:** `tests/unit/runner/_stub-service.ts` (new file)
- **Commit:** `fb2d8b5` (RED)

**3. [Rule 3 - Blocking] Plan references User-add-status fixture from plan 04-01 (wave-1 parallel)**
- **Found during:** RED phase setup
- **Issue:** LM-1 test uses `tests/_helpers/sample-migrations/User-add-status/v1.ts`. This fixture was to be created by plan 04-01, but didn't exist in this worktree.
- **Fix:** Created User-add-status fixture (v1/v2/migration/index) following the same pattern as plan 04-01's design (confirmed by reading the plan 04-01 spec and other worktrees).
- **Files modified:** `tests/_helpers/sample-migrations/User-add-status/` (4 new files)
- **Commit:** `fb2d8b5` (RED)

**4. [Rule 1 - Design] LP test approach changed from temp-dir to vi.mock hoisting**
- **Found during:** RED phase test design
- **Issue:** Plan's implementation section says "prefer temp-dir approach" for disk side. But LP-4 requires Team entity fixtures (Team v1→v2, Team v2→v3) which aren't in the plan's `files_modified` list. Creating Team fixtures would add unplanned files. Additionally, using `vi.mock` at module level for both `node:fs/promises` and `load-migration-module.js` is cleaner and avoids the need for real TS files on disk for LP tests.
- **Fix:** Used `vi.mock` hoisted mocks for `node:fs/promises readdir` and `loadMigrationFile`. Each LP test configures per-test behavior via `mockResolvedValue`/`mockRejectedValue`. LM tests use `vi.importActual` for real jiti loading.
- **Files modified:** `tests/unit/runner/load-pending.test.ts`
- **Commit:** `63ad361` (GREEN)

## Verification Results

| Check | Result |
|-------|--------|
| `grep "EDBMigrationLoadError" src/index.ts` | NO match (internal-only) ✓ |
| `grep "RUN-06\|RUN-07\|Open Question" src/runner/load-pending.ts` | 7+ hits ✓ |
| `src/runner/load-migration-module.ts` min_lines 30 | 47 lines ✓ |
| `src/runner/load-pending.ts` min_lines 60 | 163 lines ✓ |
| RED commit exists (`test(04-04)`) | `fb2d8b5` ✓ |
| GREEN commit exists (`feat(04-04)`) | `63ad361` ✓ |
| User-add-tier fixture builds User v2→v3 | verified (v1.ts=UserV2, v2.ts=UserV3) ✓ |

## Known Stubs

None — both modules have real implementations. `loadMigrationFile` uses real jiti. `loadPendingMigrations` performs real disk + DDB scan correlation. No placeholder text or empty return values.

## Threat Flags

No new network endpoints, auth paths, or file access patterns introduced beyond those documented in the plan's threat model. `loadMigrationFile` executes arbitrary user code via jiti (T-04-04-01 accepted disposition — by design).

## Self-Check: PASSED

- `src/runner/load-migration-module.ts` exists ✓
- `src/runner/load-pending.ts` exists ✓
- `tests/_helpers/sample-migrations/User-add-status/` (4 files) exist ✓
- `tests/_helpers/sample-migrations/User-add-tier/` (4 files) exist ✓
- `tests/unit/runner/_stub-service.ts` exists ✓
- `tests/unit/runner/load-pending.test.ts` exists ✓
- Commit `fb2d8b5` (RED) exists in git log ✓
- Commit `63ad361` (GREEN) exists in git log ✓
- `grep "EDBMigrationLoadError" src/index.ts` returns NO match ✓
- `grep "RUN-06\|RUN-07\|Open Question" src/runner/load-pending.ts` returns 7+ hits ✓

---
*Phase: 04-apply-release-finalize-runner*
*Completed: 2026-05-08*
