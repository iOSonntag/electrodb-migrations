---
phase: 03-internal-entities-lock-guard
plan: 05
subsystem: guard
tags: [guard, aws-sdk-middleware, cache, fail-closed, fan-out-dedup, lambda-thaw, source-scan, grd-01, grd-02, grd-03, grd-04, grd-05, grd-06, grd-07, decision-a7, pitfall-1, pitfall-2, pitfall-3]
requires:
  - phase: 03-internal-entities-lock-guard
    plan: 03-02
    provides: MigrationsServiceBundle, _migration_state entity surface
  - phase: 03-internal-entities-lock-guard
    plan: 03-04
    provides: readLockRow (sole strongly-consistent reader for src/lock + src/guard), source-scan invariant test scaffold
  - phase: 01-foundation-safety-primitives
    provides: EDBMigrationInProgressError, CONSISTENT_READ named import
provides:
  - guard-subsystem-module
  - wrapClient (GRD-01: AWS SDK v3 middleware on client.middlewareStack at step 'initialize'; both DynamoDBClient and DynamoDBDocumentClient)
  - createLockStateCache (GRD-03 / GRD-06 / GRD-07: TTL'd cache with in-flight dedup, fail-closed on fetch errors, Lambda thaw guard via wall-clock Date.now())
  - GATING_LOCK_STATES (GRD-04: frozen 5-member ReadonlySet — apply/rollback/release/failed/dying; finalize EXCLUDED per WAVE0-NOTES Decision A7)
  - isReadCommand (GRD-05: read/write classifier covering raw client + lib-dynamodb DocumentClient command names)
  - source-scan invariants for src/lock/ + src/guard/ (LCK-07, GRD-02, Pitfall #2)
affects:
  - 03-06 lock integration tests (the integration paths now have a guard subsystem to exercise alongside the lock)
  - 03-07 guard integration tests (BLD-04 eventual-consistency simulator + intercept-all-commands middleware probe)
  - 04 createMigrationsClient.guardedClient (Phase 4 wires wrapClient into the public surface)
tech-stack:
  added: []
  patterns:
    - "Single-middleware-per-client, registered on `client.middlewareStack` with `step: 'initialize'` — Pitfall #3 mitigated; lib-dynamodb command-stack drop avoided"
    - "Closure-encapsulated cache state machine (mirrors src/safety/heartbeat-scheduler.ts): pending-Promise gate for in-flight dedup, wall-clock Date.now() for TTL, fail-closed catch that always throws EDBMigrationInProgressError"
    - "Ready-only allowlist as `ReadonlySet<string>` exported from a single source-of-truth file with JSDoc that links to the load-bearing decision (WAVE0-NOTES Decision A7)"
    - "Fake-client middleware test pattern: capture the middleware via the spied `middlewareStack.add`, then invoke it directly with synthesized `(next, context)(rawArgs)` — exercises every branch without touching the AWS SDK runtime"
    - "Test getter pattern (`fake.middleware()`) replaces non-null assertions in tests — biome-clean and fails loudly if `wrapClient` did not register a middleware"
key-files:
  created:
    - src/guard/lock-state-set.ts
    - src/guard/classify.ts
    - src/guard/cache.ts
    - src/guard/wrap.ts
    - src/guard/index.ts
    - tests/unit/guard/lock-state-set.test.ts
    - tests/unit/guard/classify.test.ts
    - tests/unit/guard/cache.test.ts
    - tests/unit/guard/wrap.test.ts
  modified:
    - tests/unit/lock/source-scan.test.ts
  deleted: []
decisions:
  - "GATING_LOCK_STATES has exactly 5 members and EXCLUDES 'finalize' per WAVE0-NOTES Decision A7 — README §1 wins (the JSDoc cites the WAVE0-NOTES path so any future re-discovery of GRD-04 lands at the documented decision)"
  - "Cache stores opaque LockStateValue (`{value, runId?}`); the middleware — not the cache — decides what gates and what passes. The cache is value-agnostic so future blockMode variants can reuse it."
  - "Null lock row (fresh project, never bootstrapped) is mapped to `{value: 'free'}` inside the wrapClient closure; the cache itself never synthesizes free — fail-closed remains the cache's only escape on errors"
  - "Fail-closed cause is the original error MESSAGE (not the Error object) — keeps `details: Readonly<Record<string, unknown>>` JSON-clonable and avoids accidentally surfacing stack traces through user error handlers; preserves Plan 04's pattern"
  - "wrap.ts kept under the 80-line cap (79 lines) — JSDoc condensed from a markdown table to a single behavior paragraph after the auto-format pass; the Pitfall #3 rationale and Decision A7 cross-reference are still present"
  - "Test getter API (`fake.middleware()` throws if not yet registered) eliminates 11 non-null assertions that biome flagged. The thrown Error message names the failure mode so a future test author does not need to debug a `null` ref."
metrics:
  tasks_completed: 2
  tasks_total: 2
  unit_tests_added: 49
  unit_tests_total: 591
  files_changed: 10
  lines_added: 737
  lines_removed: 15
  duration_minutes: 9
  completed: "2026-05-08"
---

# Phase 3 Plan 05: Guard Subsystem Summary

**One-liner:** Five guard files under `src/guard/` (`lock-state-set.ts`, `classify.ts`, `cache.ts`, `wrap.ts`, barrel) implement GRD-01..07: AWS SDK v3 middleware registered on `client.middlewareStack` (Pitfall #3 mitigated), per-process TTL'd cache with in-flight dedup + Lambda thaw guard + fail-closed on fetch errors (Pitfall #1, GRD-06/07), and a frozen 5-member `GATING_LOCK_STATES` set that intentionally excludes `'finalize'` per WAVE0-NOTES Decision A7. The Plan 04 source-scan invariant test was widened to cover `src/guard/` alongside `src/lock/`.

## What Was Done

### The four guard primitives + barrel + extended source-scan

| Symbol                  | File                          | Role                                                                             | Calls                                                                                         |
| ----------------------- | ----------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `wrapClient`            | `src/guard/wrap.ts`           | AWS SDK middleware installer (GRD-01)                                            | `createLockStateCache` + `readLockRow` from `src/lock/index.js` + `EDBMigrationInProgressError` |
| `createLockStateCache`  | `src/guard/cache.ts`          | TTL'd, in-flight-deduped, fail-closed cache (GRD-03 / GRD-06 / GRD-07)           | `EDBMigrationInProgressError` (on fetch failure)                                              |
| `isReadCommand`         | `src/guard/classify.ts`       | Read/write classifier for `blockMode: 'writes-only'` (GRD-05)                    | (none — pure)                                                                                  |
| `GATING_LOCK_STATES`    | `src/guard/lock-state-set.ts` | Frozen 5-member gating allowlist (GRD-04, Decision A7)                           | (none — constant)                                                                              |
| `index.ts`              | `src/guard/index.ts`          | Named-only barrel: re-exports the four symbols + 3 supporting types              | —                                                                                              |
| source-scan (extended)  | `tests/unit/lock/source-scan.test.ts` | LCK-07 / GRD-02 / Pitfall #2 invariants now cover BOTH `src/lock/` and `src/guard/` | reads `src/{lock,guard}/**/*.ts`                                                              |

### `wrapClient` (GRD-01..07 — the single gate between user code and a guarded DDB call)

```ts
export interface WrapClientArgs {
  client: DynamoDBClient | DynamoDBDocumentClient;
  config: ResolvedConfig;
  internalService: MigrationsServiceBundle;
}

export function wrapClient(args: WrapClientArgs): DynamoDBClient | DynamoDBDocumentClient {
  const cache = createLockStateCache({
    cacheTtlMs: args.config.guard.cacheTtlMs,
    fetchLockState: async () => {
      const row = await readLockRow(args.internalService);
      if (!row) return { value: 'free' };
      const out: LockStateValue = { value: row.lockState };
      if (row.lockRunId !== undefined) out.runId = row.lockRunId;
      return out;
    },
  });

  args.client.middlewareStack.add(
    (next, context) => async (rawArgs) => {
      const commandName = (context as { commandName?: string }).commandName;
      // GRD-05: blockMode 'writes-only' lets reads through without a lock check.
      if (args.config.guard.blockMode === 'writes-only' && isReadCommand(commandName)) {
        return next(rawArgs);
      }
      // GRD-06 fail closed: cache.get() throws EDBMigrationInProgressError on read failure.
      const lockState = await cache.get();
      if (GATING_LOCK_STATES.has(lockState.value)) {
        const details: Record<string, unknown> = { lockState: lockState.value };
        if (lockState.runId !== undefined) details.runId = lockState.runId;
        throw new EDBMigrationInProgressError(
          `Migration in progress (lockState=${lockState.value}); request rejected.`,
          details,
        );
      }
      return next(rawArgs);
    },
    { step: 'initialize', name: 'electrodb-migrations-guard' },
  );

  return args.client;
}
```

**Critical contract (Pitfall #3 — load-bearing):**
- Middleware is registered on **`client.middlewareStack`**, NOT on `command.middlewareStack`. [aws-sdk-js-v3#3095] documents that `lib-dynamodb` silently drops command-level middleware (the lib recreates the underlying command and the per-command stack is lost). The integration test in Plan 03-07 will probe every command type to confirm interception.
- Step is **`'initialize'`** — runs before serialization, so blocked calls cost zero wire activity.
- `name: 'electrodb-migrations-guard'` is the canonical identifier for the registered middleware (greppable for future debugging).
- The function returns the SAME client (mutated in place) so callers keep their existing references — explicitly verified by the "returns the SAME client instance" unit test.

### `GATING_LOCK_STATES` enumeration (5 members, **finalize excluded**)

```ts
export const GATING_LOCK_STATES: ReadonlySet<string> = new Set([
  'apply',
  'rollback',
  'release',
  'failed',
  'dying',
  // 'finalize' — see Decision A7 above.
]);
```

| State        | Gates app traffic? | Why                                                                                                      |
| ------------ | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `free`       | No                 | No migration in progress.                                                                                |
| `apply`      | Yes                | Active forward migration. README §1.                                                                     |
| `rollback`   | Yes                | Active backward migration. README §1.                                                                    |
| `finalize`   | **No**             | **Decision A7** — README §1 explicitly states maintenance mode does NOT gate app traffic. Long v1 cleanup runs against the same table; v2 records are the steady state. |
| `release`    | Yes                | Release-mode handoff is in progress; `inFlightIds` on the lock row enumerate runners still draining. README §3.3. |
| `failed`     | Yes                | A runner died; operator must `unlock` before traffic resumes. README §3.4.                              |
| `dying`      | Yes                | A heartbeat watchdog has aborted; the runner has not yet finished cleanup. LCK-10.                       |

The JSDoc on `lock-state-set.ts` cites WAVE0-NOTES.md so any future engineer landing on the GRD-04 vs README §1 contradiction reads the documented decision before re-debating.

### Cache state-machine (GRD-03 / GRD-06 / GRD-07)

```
                       ┌─ get() ─┐
                       │         │
              ┌─ cached fresh? ──┴── yes ──→ return cached.value
              │ (Date.now() - cachedAt < cacheTtlMs)
              │
              no
              │
              ├─ pending Promise? ──── yes ──→ await pending  (in-flight dedup, GRD-03)
              │
              no
              │
   ┌──────────┴──────────┐
   │  pending = (async   │
   │    () => {          │
   │      try {          │
   │        v = await    │
   │          fetchLockState(); │
   │        cached = {v, Date.now()}; │
   │        return v;    │
   │      } catch (err) {│
   │        throw new EDBMigrationInProgressError(  │
   │          'Failed to read lock row...',         │
   │          { cause: err.message }                 │  ← GRD-06 / Pitfall #1: FAIL CLOSED
   │        );                                      │
   │      } finally {                               │
   │        pending = null;                         │  ← retry-after-failure pathway
   │      }                                         │
   │    })();                                       │
   └────────────────────────────────────────────────┘
```

**Pitfall #2 thaw guard (GRD-07):** the cached-fresh predicate uses `Date.now()` (wall clock — survives Lambda freeze/thaw) and additionally checks `(now - cached.cachedAt) <= cacheTtlMs * 2`. The second predicate is redundant given the first (which already enforces `< cacheTtlMs`), but documents the intent: a frozen-then-thawed Lambda whose `cachedAt` skipped past `2× TTL` MUST re-fetch.

**Failure-recovery pathway:** the `finally { pending = null }` clears the in-flight gate so the NEXT caller's `get()` retries the fetch — a single failure does not poison the cache. Verified by the "after a failure, retry is allowed" unit test.

### Source-scan extension (`src/lock/` → `src/{lock,guard}/`)

Plan 04 created `tests/unit/lock/source-scan.test.ts` with three invariants scoped to `src/lock/`. Plan 05 widens the glob to `src/{lock,guard}/**/*.ts` and adds explicit assertions that BOTH directories are observed:

```ts
expect(files.some((f) => f.includes('src/lock/'))).toBe(true);
expect(files.some((f) => f.includes('src/guard/'))).toBe(true);
```

This guards against a future relocation of either tree silently making the invariant trivially green. The three invariants — every `migrationState.get(` uses `consistent: CONSISTENT_READ`; no `setInterval(` outside comments; no inline `consistent: true` — now apply across the full chokepoint surface.

### Tests added (49 unit tests across 4 files)

| File                                       | Tests | Coverage                                                                                                |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------- |
| `tests/unit/guard/lock-state-set.test.ts`  | 4     | Set has exactly 5 members; contains apply/rollback/release/failed/dying; excludes finalize (Decision A7) and free |
| `tests/unit/guard/classify.test.ts`        | 20    | Table-driven: 18 raw + DocumentClient command names + undefined + unknown                               |
| `tests/unit/guard/cache.test.ts`           | 9     | TTL hit, TTL miss, in-flight dedup, fail-closed (Error), fail-closed (non-Error), retry-after-failure, thaw guard, reset, opaque value caching |
| `tests/unit/guard/wrap.test.ts`            | 16    | Registration shape (Pitfall #3), client-mutation return, free pass, every gating state, finalize pass (Decision A7), writes-only allowlist (read pass + write gate), blockMode 'all' on reads, fail-closed on read failure, GRD-02 ConsistentRead, GRD-03 cache hit, null-row pass |

Total suite: 591 / 591 passing (was 542 → +49 from this plan).

`pnpm typecheck` clean; `pnpm exec biome check ./src/guard ./tests/unit/guard ./tests/unit/lock/source-scan.test.ts` clean.

## Source-Scan Invariants (now enforced across src/lock/ + src/guard/)

```bash
pnpm vitest run tests/unit/lock/source-scan.test.ts          → 3/3 GREEN
grep -c "step: 'initialize'" src/guard/wrap.ts               → 1
grep -c 'electrodb-migrations-guard' src/guard/wrap.ts       → 1
grep -nE 'middlewareStack\.add' src/guard/wrap.ts            → 1 hit (line 65 — the single registration)
grep -nE "from '\\.\\./entities/" src/guard/wrap.ts          → 0 (no Phase 2-era paths)
grep -nE "^\\s*'finalize'" src/guard/lock-state-set.ts       → 0 (Decision A7 — the JSDoc names finalize but the Set construction excludes it)
wc -l src/guard/wrap.ts                                       → 79 (≤80 cap from plan <verification>)
```

`grep -c 'setInterval' src/guard/cache.ts` → 0 outside any comment. `grep -c 'CONSISTENT_READ' src/guard/wrap.ts` → 0 — the guard never imports the constant directly because it composes through `readLockRow` (the chokepoint that already enforces the option). The source-scan test confirms this composition is the only path.

## Decisions Made

- **GATING_LOCK_STATES excludes `'finalize'` per WAVE0-NOTES Decision A7.** The JSDoc on `lock-state-set.ts` cites the WAVE0-NOTES path explicitly so any future engineer arriving from REQUIREMENTS.md GRD-04 lands at the documented rationale (README §1 wins; CLAUDE.md DST-01 makes README the contract). The unit test "does NOT contain finalize" is a tripwire that fails the build if the Set is silently widened.
- **Cache stores opaque `LockStateValue`; the middleware decides what gates.** The cache is value-agnostic — it returns whatever the fetcher returned (including non-`'free'` values). This separates concerns cleanly: future variants of `blockMode` can reuse the cache without changing it. Verified by the "does NOT re-enter the cache when fetch returns a gating value" unit test.
- **Null lock row (no row in DDB) is mapped to `{value: 'free'}` inside the `wrapClient` closure**, NOT inside the cache. The cache only synthesizes errors (fail-closed); the wrapper synthesizes the safe steady-state when the bootstrap row genuinely does not exist (a fresh project on which `init`/`baseline` have not yet run). Verified by the "treats null lock row as lockState='free' — passes through" unit test.
- **Fail-closed cause is the original error MESSAGE (not the Error object).** Keeps `details: Readonly<Record<string, unknown>>` JSON-clonable and avoids surfacing stack traces through user error handlers. Preserves Plan 04's pattern (`acquire.ts` unlock paths likewise capture `.message`).
- **`wrap.ts` kept under the 80-line cap (79 lines).** The first draft included a markdown behavior table in JSDoc that pushed the file to 88 lines after biome's auto-format collapsed the throw expression. The table was condensed to a single behavior paragraph; the Pitfall #3 rationale and Decision A7 cross-reference are preserved. This matches Plan 04's heartbeat.ts trimming pattern (kept JSDoc only for the load-bearing constraints).
- **Test getter API (`fake.middleware()`) replaces non-null assertions.** biome's recommended ruleset rejects `captured.middleware!(...)` (forbidden non-null assertion). Switching to a getter that throws if `wrapClient` did not register a middleware is biome-clean AND fails loudly with an actionable error message. Eliminated 11 lint errors without sacrificing test ergonomics.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] biome auto-format reflowed the cache.ts and wrap.ts code beyond the plan's verbatim sketch**

- **Found during:** Task 1 GREEN biome check (after writing `src/guard/cache.ts`) and Task 2 GREEN biome check (after writing `src/guard/wrap.ts`).
- **Issue:** Plan 05 sketches the cache `if` predicate as a 3-line broken expression and the EDBMigrationInProgressError throw as a multi-line constructor call. biome's formatter (configured with `lineWidth: 200`) collapsed both onto single lines on `--write`.
- **Fix:** Accepted biome's reformatted output. Behavior is unchanged; only whitespace/line-breaks differ. The full unit suite (591/591) and typecheck remained green after the format pass.
- **Files modified:** `src/guard/cache.ts`, `src/guard/wrap.ts`.
- **Verification:** `pnpm exec biome check ./src/guard ./tests/unit/guard` exits 0 after auto-fix; tests + typecheck remain green.
- **Commits:** `d9f42bc` (Task 1 GREEN, cache reflowed), `35cc991` (Task 2 GREEN, wrap reflowed).

**2. [Rule 1 - Bug] biome's `lint/style/noNonNullAssertion` rejected the test scaffold sketched in Plan 05**

- **Found during:** Task 2 GREEN biome check (after writing `tests/unit/guard/wrap.test.ts`).
- **Issue:** Plan 05's verbatim test sketch uses `captured.middleware!(next, ctx)` 11 times. biome's recommended ruleset flags non-null assertions as `lint/style/noNonNullAssertion: error`; the suggested auto-fix is the optional-chain operator `?.()`, which is syntactically incompatible with calling the captured middleware (the result must be a value, not `undefined`).
- **Fix:** Refactored `makeFakeClient()` to expose a `middleware(): Middleware` getter that throws a descriptive error if `wrapClient` did not register a middleware. Replaced all 11 non-null assertions with `fake.middleware()(...)`. Behavior is identical; the thrown Error message ("wrapClient did not register a middleware on the fake client") makes debugging future test failures trivial.
- **Files modified:** `tests/unit/guard/wrap.test.ts`.
- **Verification:** `pnpm exec biome check ./tests/unit/guard` exits 0; all 16 wrap unit tests still pass.
- **Commit:** `35cc991`.

**3. [Rule 3 - Blocking] `wrap.ts` exceeded the plan's `<verification>` cap of ≤80 lines after auto-format**

- **Found during:** Task 2 GREEN, after biome auto-format collapsed the throw expression onto a single line (which slightly reduced overall line count) but the verbose JSDoc (markdown behavior table) still pushed the file to 88 lines.
- **Issue:** Plan 05's `<verification>` enumerates `src/guard/wrap.ts is ≤80 lines (Pitfall #3 — keep the middleware install obvious)`. 88 > 80.
- **Fix:** Trimmed the JSDoc from a markdown table to a single behavior paragraph. The Pitfall #3 rationale ("middleware MUST be registered on `client.middlewareStack`, NEVER on `command.middlewareStack`") and Decision A7 cross-reference are preserved; only the rendered table was removed (the four-row truth-table is now a single condensed paragraph). Final file: 79 lines.
- **Files modified:** `src/guard/wrap.ts`.
- **Verification:** `wc -l src/guard/wrap.ts` → 79; tests + typecheck + biome remain green.
- **Commit:** `35cc991`.

### Cosmetic — biome import-order auto-fix

The first draft of `src/guard/wrap.ts` imported `createLockStateCache` value before its companion type imports (`type LockStateCache`, `type LockStateValue`). biome's `organizeImports` rule reorders to types-first. Trivially fixed in the same auto-format pass; no behavior change.

### Source-scan invariant test stayed GREEN through the RED commit

Plan 05 Task 2's RED commit (`da3477a`) included the extended source-scan test. The test was GREEN immediately because the Task 1 source files (`cache.ts`, `classify.ts`, `lock-state-set.ts`) already comply with all three invariants — they contain zero `migrationState.get(` calls (the cache calls `readLockRow` which is the chokepoint), zero `setInterval(` patterns (the cache uses `Date.now()` math, not timers), and zero inline `consistent: true` (the option lives on `read-lock-row.ts`). This matches Plan 04's pattern: invariant tests are tripwires designed to PROVE compliance, not to start RED.

### Authentication Gates

None — this plan has no external-service auth surface.

## Threat Surface Scan

No new network endpoints, file-access patterns, schema changes at trust boundaries, or auth paths beyond what the plan's `<threat_model>` enumerates. The new surface is in-process middleware on a user-supplied DDB client; the guard reads through `readLockRow` (the same chokepoint Plan 04 already audited) and writes nothing. T-03-24 (silent finalize re-introduction), T-03-25 (command-level middleware mistake), T-03-27 (concurrent fan-out fetches), T-03-29 (cache returning `'free'` after failure) are all mitigated via:

- T-03-24: snapshot test asserts `GATING_LOCK_STATES.size === 5` AND `GATING_LOCK_STATES.has('finalize') === false`. JSDoc cites WAVE0-NOTES path.
- T-03-25: source-scan invariant + the explicit grep on `step: 'initialize'` + `name: 'electrodb-migrations-guard'`. Plan 03-07 will add the integration test that probes every command type.
- T-03-27: in-flight dedup verified by the "shares ONE fetchLockState invocation across concurrent get() calls" unit test.
- T-03-29: fail-closed verified by the "fails CLOSED when fetchLockState rejects" unit test — the cache catch block always throws `EDBMigrationInProgressError`, never resolves with `value: 'free'`.

## TDD Gate Compliance

Both tasks ran the RED → GREEN cycle cleanly:

| Task | RED commit                                                             | GREEN commit                                                                |
| ---- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | `9acaa30` test(03-05): RED — failing tests for the three primitives   | `d9f42bc` feat(03-05): GREEN — guard primitives                              |
| 2    | `da3477a` test(03-05): RED — failing wrapClient + extended source-scan | `35cc991` feat(03-05): GREEN — wrapClient middleware (GRD-01..07) + barrel + extended source-scan |

Note on the source-scan test in Task 2's RED commit: that test was GREEN immediately (the Task 1 source files already comply). This is intentional — the invariant tests are tripwires designed to PROVE compliance, not to start RED. Plan 05 acceptance criterion: "`pnpm vitest run tests/unit/lock/source-scan.test.ts` exits 0 with the broader glob (asserts `src/lock/` AND `src/guard/` both comply)".

No REFACTOR commit was needed beyond biome's inline auto-format (which ran during GREEN, not as a separate refactor pass).

## Self-Check: PASSED

- `src/guard/lock-state-set.ts` exists ✓ (29 lines; frozen ReadonlySet of 5 members; finalize EXCLUDED)
- `src/guard/classify.ts` exists ✓ (39 lines; covers raw client + DocumentClient command names)
- `src/guard/cache.ts` exists ✓ (98 lines; TTL + in-flight dedup + thaw guard + fail-closed via EDBMigrationInProgressError)
- `src/guard/wrap.ts` exists ✓ (79 lines, ≤80 cap; registers ONE middleware on `client.middlewareStack` at `step: 'initialize'`)
- `src/guard/index.ts` exists ✓ (6 lines, 7 named exports: wrapClient + WrapClientArgs + createLockStateCache + LockStateCache + LockStateValue + isReadCommand + GATING_LOCK_STATES)
- `tests/unit/guard/lock-state-set.test.ts` exists ✓ (4 tests, all green)
- `tests/unit/guard/classify.test.ts` exists ✓ (20 tests, all green)
- `tests/unit/guard/cache.test.ts` exists ✓ (9 tests, all green)
- `tests/unit/guard/wrap.test.ts` exists ✓ (16 tests, all green)
- `tests/unit/lock/source-scan.test.ts` modified ✓ (glob widened to `src/{lock,guard}/**/*.ts`; explicit assertions that BOTH dirs observed)
- All 4 commits exist in git log:
  - `9acaa30` test(03-05): RED — failing tests for three primitives ✓
  - `d9f42bc` feat(03-05): GREEN — guard primitives ✓
  - `da3477a` test(03-05): RED — failing wrapClient + extended source-scan ✓
  - `35cc991` feat(03-05): GREEN — wrapClient middleware + barrel + extended source-scan ✓
- `pnpm vitest run tests/unit/guard/ tests/unit/lock/source-scan.test.ts` → 52/52 passing ✓
- `pnpm test` (full unit suite) → 591/591 passing ✓
- `pnpm typecheck` exits 0 ✓
- `pnpm exec biome check ./src/guard ./tests/unit/guard ./tests/unit/lock/source-scan.test.ts` exits 0 ✓
- Source-scan invariants GREEN across src/lock/ + src/guard/ (no `setInterval` outside comments; no inline `consistent: true`; every `migrationState.get(` uses CONSISTENT_READ via the readLockRow chokepoint) ✓
- `wc -l src/guard/wrap.ts` returns 79 (≤80 cap) ✓
- `grep -c "step: 'initialize'" src/guard/wrap.ts` → 1 ✓
- `grep -c 'electrodb-migrations-guard' src/guard/wrap.ts` → 1 ✓
- `grep -nE "^\\s*'finalize'" src/guard/lock-state-set.ts | wc -l` returns 0 (Decision A7 — JSDoc names it but Set excludes it) ✓
- No stub patterns (TODO/FIXME/placeholder) under `src/guard/` ✓
- Plan 06-08's import path `import { wrapClient } from '../guard/wrap.js'` and `import { wrapClient } from '../guard/index.js'` are now resolvable ✓
- `src/guard/wrap.ts` does NOT import from `'../entities/'` or `'../types'` (Phase 2-era paths) ✓

---

*Phase: 03-internal-entities-lock-guard*
*Completed: 2026-05-08*
