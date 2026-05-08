---
phase: 03-internal-entities-lock-guard
plan: 01
subsystem: testing

tags: [vitest, dynamodb-local, aws-sdk-v3, electrodb, integration-tests, eventual-consistency, middleware]

# Dependency graph
requires:
  - phase: 01-foundation-safety-primitives
    provides: ConsistentRead constant, heartbeat scheduler, source-scan convention from heartbeat-scheduler.test.ts
provides:
  - DDB Local lifecycle helpers (makeDdbLocalClient, createTestTable, deleteTestTable, seedLockRow, randomTableName)
  - Docker availability probe (isDdbLocalReachable, skipMessage)
  - Concurrent-acquire race harness (raceAcquires)
  - Source-scan utility (scanFiles, stripCommentLines) for LCK-07/GRD-02 invariants
  - Fake-clock wrapper (installFakeClock) for timer-driven tests
  - BLD-04 eventual-consistency simulator middleware (attachEventualConsistencyMiddleware)
  - Wave 0 spike tests verifying ElectroDB operator coverage and simulator return shape
  - WAVE0-NOTES.md decision log resolving A7 (finalize-gating), A1/A2 (operator coverage), A8 (simulator shape)
affects:
  - 03-02 (internal entities — uses createMigrationStateEntity through DDB Local helpers)
  - 03-03 (state-mutations — consumes ElectroDB-native acquire path locked in by A1/A2)
  - 03-04 (lock — uses fake-clock + source-scan helpers)
  - 03-05 (guard — uses eventual-consistency simulator + GATING_LOCK_STATES set excluding 'finalize')
  - 03-06 (lock integration tests — uses raceAcquires)
  - 03-07 (guard integration tests — uses simulator)
  - 03-08 (final invariants — uses source-scan helpers)

# Tech tracking
tech-stack:
  added:
    - none (existing devDependencies sufficient — @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, vitest, electrodb)
  patterns:
    - "Wave 0 spike pattern: spike tests under tests/integration/_spike/ verify load-bearing assumptions before downstream plans commit"
    - "Test helpers are explicitly named in barrels (no `export *`)"
    - "Integration tests fail-soft when Docker is unavailable (console.warn(skipMessage()) + early return)"
    - "AWS SDK middleware return shape includes `$metadata` on both `output` and `response` to satisfy retry middleware"

key-files:
  created:
    - tests/integration/_helpers/ddb-local.ts
    - tests/integration/_helpers/eventual-consistency.ts
    - tests/integration/_helpers/concurrent-acquire.ts
    - tests/integration/_helpers/docker-availability.ts
    - tests/integration/_helpers/index.ts
    - tests/_helpers/source-scan.ts
    - tests/_helpers/clock.ts
    - tests/_helpers/index.ts
    - tests/integration/_spike/eventual-consistency-prototype.test.ts
    - tests/integration/_spike/electrodb-where-operators.test.ts
    - .planning/phases/03-internal-entities-lock-guard/03-WAVE0-NOTES.md
  modified: []

key-decisions:
  - "A7 finalize-gating: README WINS — GATING_LOCK_STATES excludes 'finalize'; REQUIREMENTS.md GRD-04 contradiction logged for retrospective"
  - "A1/A2 ElectroDB operator coverage: all four candidate operators (eq, notExists, lt, contains) USABLE — Plan 03 takes the ElectroDB-native acquire path; no raw UpdateCommand fallback needed"
  - "A8 eventual-consistency simulator return shape: requires `$metadata` on both `output` and `response` to satisfy @smithy/middleware-retry"

patterns-established:
  - "Wave 0 spike tests under tests/integration/_spike/ — verifies load-bearing assumptions; outcomes recorded in WAVE0-NOTES.md"
  - "Test helper barrels with explicit named re-exports (never `export *`)"
  - "Two-tier _helpers split: tests/_helpers/ for cross-cutting (clock, source-scan), tests/integration/_helpers/ for integration-only (DDB Local, simulator)"

requirements-completed:
  - BLD-04

# Metrics
duration: ~25min
completed: 2026-05-08
---

# Phase 3 Plan 01: Wave 0 Test Infrastructure Summary

**DDB Local lifecycle helpers, BLD-04 eventual-consistency simulator middleware verified end-to-end, ElectroDB `where()` operator coverage spike confirms the ElectroDB-native lock-acquire path, and the A7 finalize-gating contradiction is resolved (README wins).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-08T12:54:00Z (approx — execution start)
- **Completed:** 2026-05-08T13:19:27Z
- **Tasks:** 2
- **Files created:** 11 (8 source helpers/tests + 1 decision log + 2 spike tests already counted)
- **Files modified:** 0
- **Test commits:** 2 (`f217973`, `4b74868`)

## Accomplishments

- Wave 0 helper closure complete: every later plan in Phase 3 (Plans 02–08) imports from these barrels rather than re-inventing DDB Local lifecycle, simulator, or source-scan code.
- BLD-04 eventual-consistency simulator is **verified end-to-end** against real DDB Local — both the stale-read path and the `ConsistentRead: true` bypass path round-trip cleanly through the AWS SDK middleware stack.
- A7 contradiction (REQUIREMENTS.md GRD-04 vs README §1) resolved in writing in WAVE0-NOTES.md: **README wins**. `GATING_LOCK_STATES = { 'apply', 'rollback', 'release', 'failed', 'dying' }` — `'finalize'` is excluded. Plan 05's `lock-state-set.ts` JSDoc must cite this decision.
- ElectroDB operator spike (A1/A2) confirms all four candidate operators (`eq`, `notExists`, `lt`, `contains`) are usable — Plan 03 follows the ElectroDB-native acquire path; no raw `UpdateCommand` fallback is needed. Note that `op.contains` takes a single value (not a list), so the LCK-05 release-mode-handoff `inFlightIds` membership probe uses `op.contains(inFlightIds, migId)`.
- A8 simulator return shape: requires `$metadata: { attempts: 0, totalRetryDelay: 0 }` on both `output` and `response`. The simpler shape sketched in PATTERNS.md (`response: { /* synthesized */ }`) crashes the retry middleware. The Wave 0 spike caught this before Plan 07 inherited it.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave 0 helpers — DDB Local lifecycle, source-scan, fake clock, race harness** — `f217973` (test)
2. **Task 2: BLD-04 simulator + ElectroDB where() spike + WAVE0-NOTES decision log** — `4b74868` (test)

## Files Created

### Test helpers (cross-cutting, under `tests/_helpers/`)

- `tests/_helpers/clock.ts` — `installFakeClock` wraps `vi.useFakeTimers()` + `vi.setSystemTime()` for Plan 04 heartbeat tests and Plan 05 cache thaw test
- `tests/_helpers/source-scan.ts` — `scanFiles(globPattern, predicate)` + `stripCommentLines` adapted from heartbeat-scheduler.test.ts:99-116 convention
- `tests/_helpers/index.ts` — barrel (named re-exports only)

### Integration helpers (DDB-Local-specific, under `tests/integration/_helpers/`)

- `tests/integration/_helpers/ddb-local.ts` — `makeDdbLocalClient`, `createTestTable`, `deleteTestTable`, `seedLockRow`, `randomTableName`, `DDB_LOCAL_ENDPOINT`
- `tests/integration/_helpers/docker-availability.ts` — `isDdbLocalReachable` (1s socket probe) + `skipMessage`
- `tests/integration/_helpers/concurrent-acquire.ts` — `raceAcquires` race harness for Plan 06 LCK-01
- `tests/integration/_helpers/eventual-consistency.ts` — BLD-04 AWS SDK middleware factory; intercepts `GetItemCommand` on the lock-row key, short-circuits with synthesized stale state when `ConsistentRead` is falsy
- `tests/integration/_helpers/index.ts` — barrel (named re-exports only)

### Wave 0 spike tests

- `tests/integration/_spike/eventual-consistency-prototype.test.ts` — proves both BLD-04 paths (stale + bypass) round-trip through real DDB Local
- `tests/integration/_spike/electrodb-where-operators.test.ts` — records ElectroDB `op.*` usability matrix; outcomes transcribed into WAVE0-NOTES.md

### Decision log (planning artifact — gitignored, lives only in `.planning/`)

- `.planning/phases/03-internal-entities-lock-guard/03-WAVE0-NOTES.md` — A7 finalize-gating decision (README wins), A1/A2 operator coverage matrix, A8 simulator return-shape verification

## Decisions Made

- **A7 — README wins on finalize-gating** (`GATING_LOCK_STATES` excludes `'finalize'`). Rationale: README §1 is the documentation contract per CLAUDE.md DST-01; gating finalize would block app traffic during a long deferred cleanup, defeating the design rationale. REQUIREMENTS.md GRD-04 wording is a documentation defect to be corrected in Phase 7's `validate` checklist or a follow-on quick task — not silently rewritten in Phase 3.
- **A1/A2 — ElectroDB-native acquire path** (`op.eq`, `op.notExists`, `op.lt`, `op.contains` all usable). Plan 03 does not need the raw `UpdateCommand` fallback. The membership-probe form is `op.contains(setAttr, valueElement)`, NOT the list-bracket form sketched in RESEARCH.
- **A8 — Simulator return shape requires `$metadata`** on both `output` and `response`. The `@smithy/middleware-retry` package sits later in the middleware stack than `finalizeRequest` and assigns `response.$metadata.attempts = N` after the inner handler returns; without the `$metadata` skeleton the assignment crashes with `TypeError: Cannot set properties of undefined (setting 'attempts')`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Eventual-consistency simulator return shape needed `$metadata` skeleton**
- **Found during:** Task 2 (`eventual-consistency-prototype.test.ts` first run failed)
- **Issue:** The simulator's synthesized return shape from PATTERNS.md (`{ output: { Item: previousState }, response: {} }`) crashed `@smithy/middleware-retry` with `TypeError: Cannot set properties of undefined (setting 'attempts')`. The retry middleware sits later in the stack and tries to assign `response.$metadata.attempts` after the inner handler returns.
- **Fix:** Updated the synthesized response to include `$metadata: { attempts: 0, totalRetryDelay: 0 }` on both `output` and `response`.
- **Files modified:** `tests/integration/_helpers/eventual-consistency.ts`
- **Verification:** `pnpm vitest run --config vitest.integration.config.ts tests/integration/_spike/` — both stale-read and bypass paths pass.
- **Committed in:** `4b74868` (Task 2)

**2. [Rule 1 - Bug] ElectroDB spike's "expected condition failure" regex was too narrow**
- **Found during:** Task 2 (`electrodb-where-operators.test.ts` first run reported all four operators as `usable: false`)
- **Issue:** The regex `/ConditionalCheckFailed|Conditional check failed|item not found|exist/i` did not match ElectroDB's wrapped error message `Error thrown by DynamoDB client: "The conditional request failed"`. Operators that DID reach DDB were misclassified as unusable.
- **Fix:** Tightened the regex to match `/conditional request failed|ConditionalCheckFailed/i` — the precise tokens ElectroDB surfaces when the operator rendered correctly but the row didn't satisfy the condition.
- **Files modified:** `tests/integration/_spike/electrodb-where-operators.test.ts`
- **Verification:** Re-ran the spike; all four operators correctly identified as usable. Outcomes recorded in WAVE0-NOTES.md.
- **Committed in:** `4b74868` (Task 2)

**3. [Rule 3 - Blocking] Task 1 barrel referenced eventual-consistency.ts (created in Task 2)**
- **Found during:** Task 1 (drafting the barrel)
- **Issue:** The PLAN.md verbatim sketch for the Task 1 barrel re-exported `attachEventualConsistencyMiddleware` from `./eventual-consistency.js`, but Task 1's acceptance criteria explicitly say `eventual-consistency.ts` is NOT created in Task 1 (deferred to Task 2). The barrel as written would fail typecheck.
- **Fix:** Created the Task 1 barrel WITHOUT the eventual-consistency exports, with a JSDoc note explaining Task 2 adds them. Task 2 then re-wrote the barrel with the full export set.
- **Files modified:** `tests/integration/_helpers/index.ts` (in Task 1, then again in Task 2)
- **Verification:** `pnpm typecheck` clean after Task 1; clean again after Task 2.
- **Committed in:** Split across `f217973` (Task 1) and `4b74868` (Task 2)

**4. [Rule 3 - Blocking] Worktree did not have `node_modules`**
- **Found during:** Task 1 (running `pnpm typecheck` and `pnpm exec biome check` in the worktree)
- **Issue:** The Claude Code worktree was created without dependencies installed; `pnpm exec biome` failed with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "biome" not found`.
- **Fix:** Ran `pnpm install --offline` in the worktree to materialize the dependency tree from the existing pnpm cache.
- **Files modified:** none in the source tree (only `node_modules/`, which is gitignored)
- **Verification:** Subsequent `pnpm typecheck` and `pnpm exec biome check` ran successfully.
- **Committed in:** N/A (environmental fix, no source change)

---

**Total deviations:** 4 auto-fixed (2 bugs in my own implementation, 1 blocking plan inconsistency, 1 environmental)
**Impact on plan:** Two bug fixes (deviations 1 and 2) caught real defects in the plan's reference patterns — the simulator shape and the spike's classification regex. Both are now correct and load-bearing for Plans 03 and 07. Deviation 3 reconciles a contradiction internal to PLAN.md (the Task 1 barrel content was the post-Task-2 state, not the post-Task-1 state). No scope creep.

## Issues Encountered

- The Claude Code worktree initially lacked `node_modules` — fixed with `pnpm install --offline` (deviation 4).
- During my initial Write tool calls in Task 1, I used absolute paths under `/Users/oliver/development/Repositories/open-source/electrodb-migrations/...` instead of the worktree path `/Users/oliver/development/Repositories/open-source/electrodb-migrations/.claude/worktrees/agent-a20855339d4a2679e/...`. The files landed in the parent repo (on `main`) instead of the worktree branch. I caught the divergence at the first commit attempt (the safety check correctly flagged "FATAL: protected" because `cd` from the parent took me onto `main`). I `mv`'d all files into the worktree, verified the parent repo was clean, and proceeded. No commit was ever made on `main`.

## User Setup Required

None — Wave 0 is purely test infrastructure under `tests/`. No external services, no secrets, no environment variables added. Integration tests require Docker + DDB Local to be running; the existing `docker-compose.yml` covers this and the Docker availability probe (`isDdbLocalReachable`) lets tests fail soft when it's not.

## Next Phase Readiness

- **Plan 03-02 (internal entities)** can now write integration tests using `makeDdbLocalClient` + `createTestTable` + `seedLockRow` directly.
- **Plan 03-03 (state-mutations)** has a confirmed ElectroDB-native acquire path — no raw `UpdateCommand` fallback work needed. Ship `acquire.ts` with `op.eq`/`op.notExists`/`op.contains`/`op.lt` as planned.
- **Plan 03-04 (lock)** has `installFakeClock` ready for the heartbeat test suite.
- **Plan 03-05 (guard)** has the `GATING_LOCK_STATES` decision in writing — implement the set as `{ 'apply', 'rollback', 'release', 'failed', 'dying' }` and cite WAVE0-NOTES in the JSDoc.
- **Plan 03-07 (guard integration)** has a verified BLD-04 simulator. Use the helper directly; do NOT modify the simulator's return shape (the `$metadata` skeleton is load-bearing).
- **Plan 03-08 (source-scan invariants)** has `scanFiles`/`stripCommentLines` ready and a worked example in heartbeat-scheduler.test.ts:99-116.

## Self-Check: PASSED

- `tests/integration/_helpers/ddb-local.ts` exists ✓
- `tests/integration/_helpers/eventual-consistency.ts` exists ✓
- `tests/integration/_helpers/concurrent-acquire.ts` exists ✓
- `tests/integration/_helpers/docker-availability.ts` exists ✓
- `tests/integration/_helpers/index.ts` exists ✓
- `tests/_helpers/source-scan.ts` exists ✓
- `tests/_helpers/clock.ts` exists ✓
- `tests/_helpers/index.ts` exists ✓
- `tests/integration/_spike/eventual-consistency-prototype.test.ts` exists ✓
- `tests/integration/_spike/electrodb-where-operators.test.ts` exists ✓
- `.planning/phases/03-internal-entities-lock-guard/03-WAVE0-NOTES.md` exists (in worktree AND copied to parent repo `.planning/`) ✓
- Commit `f217973` (Task 1) exists in `git log` ✓
- Commit `4b74868` (Task 2) exists in `git log` ✓
- `pnpm typecheck` exits 0 ✓
- `pnpm test` exits 0 (424 passing) ✓
- `pnpm vitest run --config vitest.integration.config.ts tests/integration/_spike/` exits 0 (2 passing) ✓
- `pnpm exec biome check ./tests/_helpers ./tests/integration/_helpers ./tests/integration/_spike` exits 0 ✓

---
*Phase: 03-internal-entities-lock-guard*
*Completed: 2026-05-08*
