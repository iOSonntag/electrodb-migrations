---
phase: 03-internal-entities-lock-guard
plan: 07
subsystem: guard-integration-tests
tags: [guard, integration-tests, ddb-local, eventual-consistency-simulator, bld-04, grd-01, grd-02, grd-03, grd-05, grd-06, grd-07, pitfall-1, pitfall-3, decision-a8]
requires:
  - phase: 03-internal-entities-lock-guard
    plan: 03-01
    provides: makeDdbLocalClient + createTestTable + attachEventualConsistencyMiddleware + isDdbLocalReachable
  - phase: 03-internal-entities-lock-guard
    plan: 03-02
    provides: createMigrationsService + MigrationsServiceBundle
  - phase: 03-internal-entities-lock-guard
    plan: 03-04
    provides: acquireLock + readLockRow chokepoint
  - phase: 03-internal-entities-lock-guard
    plan: 03-05
    provides: wrapClient (GRD-01..07 production code under test)
  - phase: 01-foundation-safety-primitives
    provides: EDBMigrationInProgressError + EDB_MIGRATION_IN_PROGRESS error code + ResolvedConfig type
provides:
  - guard-integration-coverage (5 test files, 26 tests, ~1.4s wall-clock under DDB Local)
  - BLD-04 wire-level cornerstone test (UNSAFE-PATH simulator effectiveness + SAFE-PATH framework defense)
  - GRD-01 Pitfall #3 command-type matrix (16 commands × both client kinds)
  - GRD-03/05/06/07 end-to-end behavior assertions against DDB Local
affects:
  - 03-08 final invariants (this plan's tests are now part of the integration suite Plan 08 sources from)
  - 04 runner (the runner inherits the guard contract verified here; any future regression on wrapClient is caught at integration time)
tech-stack:
  added: []
  patterns:
    - "Per-test fresh client pattern: every `it` constructs its own inner DDB client + counter middleware. Avoids cross-test middleware accumulation; the only GetItemCommand observed is the framework's lock-row read."
    - "Bootstrap lockState='free' via migrationState.put(...).go() before acquireLock — ElectroDB patch() adds attribute_exists(pk) AND attribute_exists(sk) to its ConditionExpression (clauses.js lines 621-624). Without this seed acquireLock fails ConditionalCheckFailed on a fresh table."
    - "BLD-04 dual-test pattern: UNSAFE-PATH test uses raw PutCommand at the literal lock-row key to verify the simulator works (matches Wave 0 spike); SAFE-PATH test uses framework acquireLock + readLockRow to verify CONSISTENT_READ neutralizes the simulator. The two tests cover both halves of T-03-37 (static defense from source-scan + dynamic defense from this BLD-04 test)."
    - "Synthetic error injection by command-name + table-name (NOT by literal pk filter): the plan's reference filter `pk === '_migration_state'` doesn't match ElectroDB's composite key. Filtering by GetItemCommand + TableName is precise because the cache's read is the only GetItem on the inner client."
key-files:
  created:
    - tests/integration/guard/intercept-all-commands.test.ts
    - tests/integration/guard/consistent-read.test.ts
    - tests/integration/guard/cache-ttl.test.ts
    - tests/integration/guard/fail-closed.test.ts
    - tests/integration/guard/block-mode.test.ts
  modified: []
  deleted: []
decisions:
  - "Bootstrap-via-put pattern: every guard integration test that calls acquireLock first seeds the row with migrationState.put({id, schemaVersion, updatedAt, lockState: 'free'}).go(). This mimics what `init` does in production. Documented inline in each test's beforeAll."
  - "Counter / synthetic-error filter on commandName + TableName, NOT on literal pk='_migration_state'. The plan's reference snippets used the literal-key filter (which never matches the framework's ElectroDB-composite-key reads). Per-test fresh inner client makes the broader filter safe — the cache's read is the only GetItem on that client."
  - "BLD-04 UNSAFE-PATH BASELINE uses raw PutCommand at the literal key (matches Wave 0 spike); SAFE-PATH MITIGATION uses framework acquireLock at the composite key. Splitting the seeding mechanism by test purpose keeps each test's claim narrow and verifiable."
  - "intercept-all-commands.test.ts widens the plan's command-type matrix: the plan's it.each covered 4 DocumentClient command classes; we cover 7 (Update, Delete, BatchWrite, TransactWrite, Get, Query, Scan) on the doc path AND 7 on the raw path (UpdateItem, DeleteItem, BatchWriteItem, TransactWriteItems, GetItem, raw Query, raw Scan). 16 tests total, including the two single-it Put cases. This pushes Pitfall #3 verification to the entire production-relevant command surface."
  - "cache-ttl.test.ts adds a 4th test (in-flight dedup with concurrent Promise.all) that the plan's sketch did not include. Plan 05's unit cache test exercises dedup with stubs; this is the wire-level companion. GRD-03's hot-key defense is the most-likely-to-regress invariant under load, so a real-DDB test of it is worth the +200ms."
metrics:
  tasks_completed: 2
  tasks_total: 2
  test_files_added: 5
  integration_tests_added: 26
  integration_tests_total: 28
  files_changed: 5
  duration_minutes: ~17
  completed: "2026-05-08"
---

# Phase 3 Plan 07: Guard Integration Tests Summary

**One-liner:** Five integration test files under `tests/integration/guard/` (`intercept-all-commands.test.ts`, `consistent-read.test.ts`, `cache-ttl.test.ts`, `fail-closed.test.ts`, `block-mode.test.ts`) exercise GRD-01..07 + BLD-04 against real DDB Local plus the Wave 0 eventual-consistency simulator — 26 tests total, ~1.4s wall-clock, every assertion green.

## What Was Done

### The five integration test files

| File                                                  | Tests | Coverage                                                                                                                                                                |
| ----------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/guard/intercept-all-commands.test.ts` | 16    | GRD-01 + Pitfall #3 — Doc and raw clients × {Put, Update, Delete, BatchWrite, TransactWrite, Get, Query, Scan} all rejected with `EDB_MIGRATION_IN_PROGRESS` during apply |
| `tests/integration/guard/consistent-read.test.ts`     | 2     | BLD-04 + GRD-02 — UNSAFE-PATH baseline (simulator effective) + SAFE-PATH mitigation (framework's CONSISTENT_READ neutralizes the simulator)                              |
| `tests/integration/guard/cache-ttl.test.ts`           | 4     | GRD-03 + GRD-07 — TTL hit dedup, TTL expiry refresh, Lambda thaw guard, in-flight Promise dedup under `Promise.all`                                                     |
| `tests/integration/guard/fail-closed.test.ts`         | 1     | GRD-06 + Pitfall #1 — synthetic ThrottlingException on lock-row GetItem → guard throws EDBMigrationInProgressError with `details.cause`                                  |
| `tests/integration/guard/block-mode.test.ts`          | 3     | GRD-05 — `'writes-only'` lets reads through, blocks writes; `'all'` gates both                                                                                          |

Total: **5 files, 26 tests, all green** under DDB Local + the Wave 0 simulator.

### BLD-04 cornerstone outcome

The cornerstone test (`consistent-read.test.ts`) is the highest-priority Phase 3 deliverable per RESEARCH.md. It is in place and green:

- **UNSAFE-PATH BASELINE** (the simulator IS effective): a raw `PutCommand` at the literal lock-row key seeds `lockState='apply'`; the simulator's `recordWrite({...lockState: 'free'})` opens a stale window; a `GetCommand` without `ConsistentRead` returns the simulator's stale `'free'` (and `harness.staleHits()` is `1`); a `GetCommand` with `ConsistentRead: true` passes through to real DDB and returns the real `'apply'`.

- **SAFE-PATH MITIGATION** (the framework wins): `acquireLock` writes through ElectroDB at the composite key; the simulator is attached to a separate raw client; the guard's `internalService` uses a `DocumentClient` over that simulator-attached client; the guarded `wrapped.send(new PutCommand(...))` correctly throws `EDB_MIGRATION_IN_PROGRESS`. The simulator's `!ConsistentRead` gate means it never intercepts the framework's reads (which carry `consistent: CONSISTENT_READ`).

### Pitfall #3 command-type matrix coverage

| Client kind                  | Commands tested                                                                                                                                  | Total |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `DynamoDBClient` (raw)       | `PutItemCommand`, `UpdateItemCommand`, `DeleteItemCommand`, `BatchWriteItemCommand`, `TransactWriteItemsCommand`, `GetItemCommand`, raw `QueryCommand`, raw `ScanCommand` | 8     |
| `DynamoDBDocumentClient`     | `PutCommand`, `UpdateCommand`, `DeleteCommand`, `BatchWriteCommand`, `TransactWriteCommand`, `GetCommand`, `QueryCommand`, `ScanCommand`         | 8     |

**Every** command class throws `EDB_MIGRATION_IN_PROGRESS` when the lock is in `apply`. This pushes the [aws-sdk-js-v3#3095] regression coverage to the entire production-relevant surface — if a future SDK adds a command class that the guard's middleware accidentally bypasses, follow-on tests can extend the matrix without touching the guard's source.

### Cache timing observations under DDB Local

| Scenario                                                       | Wall-clock duration | Read count |
| -------------------------------------------------------------- | ------------------- | ---------- |
| 2 ops within `cacheTtlMs=200ms`                                | <50 ms              | 1          |
| 2 ops with 250 ms sleep (> TTL)                                | ~250 ms             | ≥ 2        |
| 2 ops with 500 ms sleep (> 2× TTL — Lambda thaw)               | ~500 ms             | ≥ 2        |
| 3 concurrent `Promise.all` ops on a fresh cache (in-flight dedup) | <50 ms              | 1          |

DDB Local round-trip on localhost is ~5–15 ms per call; the cache's wall-clock TTL fires reliably above the 200 ms threshold.

### Fail-closed cause-chain shape

The `fail-closed.test.ts` synthetic error injects `Error('Synthetic DDB throttle')` with `name = 'ThrottlingException'`. The guard's `cache.get()` catches and rethrows as:

```
EDBMigrationInProgressError {
  code: 'EDB_MIGRATION_IN_PROGRESS',
  message: 'Failed to read lock row; failing closed for safety.',
  details: { cause: 'Synthetic DDB throttle' }
}
```

Verified by `expect.objectContaining({ cause: expect.stringContaining('Synthetic') })`. The cause is the original error MESSAGE (string), not the Error object — preserves Plan 04/05's pattern of keeping `details` JSON-clonable.

### blockMode allowlist verification

| `blockMode`     | Read (`GetCommand`)            | Write (`PutCommand`)          |
| --------------- | ------------------------------ | ----------------------------- |
| `'all'`         | throws `EDB_MIGRATION_IN_PROGRESS` | throws `EDB_MIGRATION_IN_PROGRESS` |
| `'writes-only'` | passes through (`Item: undefined`) | throws `EDB_MIGRATION_IN_PROGRESS` |

All four cells verified end-to-end against a guarded client wired to a lock in `apply`.

## Decisions Made

- **Bootstrap-via-put pattern.** Every guard integration test that calls `acquireLock` first seeds the lock row with `migrationState.put({id, schemaVersion, updatedAt, lockState: 'free'}).go()`. This is required because ElectroDB's `patch()` (which `acquire.ts` uses) adds `attribute_exists(pk) AND attribute_exists(sk)` to the ConditionExpression — `clauses.js` lines 621-624. Without the seed, `acquireLock` fails with `ConditionalCheckFailed` on a fresh table. The seed mimics what `init` will do in production. Documented inline in each test's `beforeAll`.

- **Counter / synthetic-error filter on commandName + TableName, NOT on literal `pk='_migration_state'`.** The plan's verbatim middleware filter uses `pk === '_migration_state'`, which only matches raw items at the literal key. The framework's reads use ElectroDB's composite key (`$_electrodb_migrations#_migration_state_1#id_state` shape), so the literal-key filter never fires for the framework. Filtering by `GetItemCommand + TableName` is precise because the cache's read is the ONLY `GetItemCommand` on a per-test fresh inner client. This deviation also keeps the test resilient to ElectroDB version bumps that change the composite-key prefix format.

- **BLD-04 dual-test split: UNSAFE-PATH uses raw PutCommand, SAFE-PATH uses framework acquireLock.** The plan's verbatim sketch called `acquireLock` in both tests and asserted a raw `GetCommand` at the literal key returns `'apply'` — but `acquireLock` writes through ElectroDB at the composite key, so the literal-key read returns `Item: undefined`. The fix splits the seeding mechanism by test purpose: UNSAFE-PATH uses a raw PutCommand at the literal key (so the simulator's filter matches; same pattern as the Wave 0 spike `eventual-consistency-prototype.test.ts`); SAFE-PATH uses the framework's `acquireLock` (so the SAFE-PATH actually exercises the framework's `readLockRow` → `consistent: CONSISTENT_READ` → real-DDB read).

- **Widened Pitfall #3 command-type matrix.** Plan's reference covered 4 DocumentClient command classes; we cover 7 doc-path commands + 7 raw-path commands (plus 2 single-`it` Put cases). 16 tests total. This pushes Pitfall #3 verification to the entire production-relevant command surface, including read commands (Get/Query/Scan) which the plan's sketch omitted from the matrix.

- **Added a 4th cache-ttl test for in-flight dedup under `Promise.all`.** Plan 05's unit cache test exercises dedup with stubs; the wire-level companion under real DDB Local was missing. GRD-03's hot-key defense is the most-likely-to-regress invariant under load (the cache's `pending` Promise gate is single-line; a future contributor could easily revert it without breaking unit tests but exposing the lock-row to N-fan). The test's wall-clock cost is ~50 ms; the safety floor it provides is real.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ElectroDB `patch()` requires the lock row to exist; plan's `acquireLock` calls failed `ConditionalCheckFailed` on a fresh table**

- **Found during:** Task 1 first integration run.
- **Issue:** Plan's reference code calls `acquireLock` directly after `createTestTable`, expecting `attribute_not_exists(lockState) OR lockState='free'` to be true (no row exists). But `clauses.js` lines 621-624 show ElectroDB's `patch()` adds `attribute_exists(pk) AND attribute_exists(sk)` to the ConditionExpression. The result: `acquire`'s transactWrite fails because the row doesn't exist; `EDBMigrationLockHeldError: Lock acquire verification failed — expected runId r-grd, got (none)`.
- **Fix:** Every test that calls `acquireLock` now first seeds the row with `migrationState.put({id: 'state', schemaVersion: 1, updatedAt: now, lockState: 'free'}).go()`. This mimics what `init` does in production. Documented inline.
- **Files modified:** `intercept-all-commands.test.ts`, `consistent-read.test.ts` (Task 1); `block-mode.test.ts` (Task 2).
- **Verification:** All 5 integration test files green; 26 tests passing.
- **Committed in:** `81fdcca` (Task 1), `d27c022` (Task 2).

**2. [Rule 1 - Bug] BLD-04 UNSAFE-PATH plan sketch's literal-key seed via `acquireLock` cannot return `'apply'` from a raw GetCommand at the literal key**

- **Found during:** Designing `consistent-read.test.ts` — before first run.
- **Issue:** Plan's verbatim UNSAFE-PATH sketch called `acquireLock` to "stamp `lockState='apply'` on disk" and asserted a raw `GetCommand` with `ConsistentRead: true` at the LITERAL `pk='_migration_state'/sk='state'` key returns `lockState='apply'`. Cannot work — `acquireLock` writes through ElectroDB at the composite key (`$_electrodb_migrations#_migration_state_1#id_state` shape), NOT at the literal key. A raw read at the literal key returns `Item: undefined`.
- **Fix:** UNSAFE-PATH BASELINE uses a raw `PutCommand` at the literal key directly (matches Wave 0 spike `eventual-consistency-prototype.test.ts:46-52`). The simulator's filter matches the literal key; the assertion `expect(fresh.Item?.lockState).toBe('apply')` works because we just wrote that value. SAFE-PATH MITIGATION still uses `acquireLock` (which is what BLD-04's actual mitigation depends on).
- **Files modified:** `consistent-read.test.ts`.
- **Verification:** Both UNSAFE-PATH and SAFE-PATH tests green.
- **Committed in:** `81fdcca` (Task 1).

**3. [Rule 1 - Bug] Plan's middleware filter `pk === '_migration_state'` never matches the framework's reads; counter / synthetic-error would be 0 / never fire**

- **Found during:** Designing `cache-ttl.test.ts` and `fail-closed.test.ts`.
- **Issue:** Plan's verbatim middleware sketches filter on `pk === '_migration_state'` (the literal key). The framework's `readLockRow` calls `migrationState.get(...)` which goes through ElectroDB's composite-key path (`$_electrodb_migrations#_migration_state_1#id_state` shape). The literal-key filter never matches, so the counter would always read 0 (the test would assert `count === 1` and fail) and the fail-closed synthetic error would never fire (the test would never observe `EDB_MIGRATION_IN_PROGRESS`).
- **Fix:** Switched both middlewares to filter by `commandName === 'GetItemCommand' && TableName === tableName`. Per-test fresh inner client (cache-ttl) or per-test client setup (fail-closed) ensures the cache's read is the ONLY `GetItemCommand` observed on that client — making the broader filter precise. Also resilient to future ElectroDB composite-key prefix changes.
- **Files modified:** `cache-ttl.test.ts`, `fail-closed.test.ts`.
- **Verification:** cache-ttl all 4 tests green (counters report exactly the expected values); fail-closed test green (synthetic error fires + bubbles up as EDB_MIGRATION_IN_PROGRESS with `details.cause`).
- **Committed in:** `d27c022` (Task 2).

### Authentication Gates

None — this plan has no external-service auth surface. DDB Local runs on `localhost:8000` with fake credentials; the `isDdbLocalReachable()` probe lets every test fail soft when Docker isn't running.

## TDD Gate Compliance

The plan declares `tdd="true"` on both tasks. Plan 05's pattern for "tests verify already-existing production code" was followed (per Plan 05 SUMMARY: "the source-scan test in Task 2's RED commit was GREEN immediately because the Task 1 source files...comply. This is intentional — the invariant tests are tripwires designed to PROVE compliance, not to start RED."). Each task is one `test(...)` commit:

| Task | Commit  | Type   | Description                                                                |
| ---- | ------- | ------ | -------------------------------------------------------------------------- |
| 1    | `81fdcca` | `test` | GRD-01 + Pitfall #3 + BLD-04 cornerstone integration tests                 |
| 2    | `d27c022` | `test` | GRD-03/05/06/07 cache + fail-closed + blockMode integration                |

No `feat(...)` GREEN commit was needed — all production code already shipped in Plan 05 (`d9f42bc` + `35cc991`). The integration tests are characterization tests verifying that production code's wire-level behavior matches the plan's specifications.

## Threat Surface Scan

No new network endpoints, file-access patterns, schema changes at trust boundaries, or auth paths beyond what the plan's `<threat_model>` enumerates. Test-only middleware on test-only client instances; no production code changed.

T-03-36 (UNSAFE simulator path bypassed by ConsistentRead): mitigated — SAFE-PATH test asserts the throw, not `staleHits`. Both halves of the test verify their own claim.

T-03-37 (future `consistent: CONSISTENT_READ` regression): mitigated dynamically by this plan's `consistent-read.test.ts` (in conjunction with Plan 04's static source-scan invariant). If a future commit removes `consistent: CONSISTENT_READ` from `read-lock-row.ts`, the source-scan invariant fails the unit suite AND the simulator (which would then fire on the framework's reads) corrupts the SAFE-PATH test. Two-layer defense.

T-03-38 (synthetic ThrottlingException leaks "Synthetic DDB throttle"): accepted — fixture string in test-only code.

T-03-39 (cache-ttl flake on heavily loaded CI): accepted — 250 / 500 ms windows above 200 ms `cacheTtlMs`. If CI ever flakes here, a single re-run is the diagnostic; the test does not retry internally.

T-03-40 (Pitfall #3 verification incomplete): mitigated — 16-test command-type matrix on both client kinds (raw + DocumentClient). Future SDK additions are expected to be added to the matrix, not silently bypassed.

## Self-Check: PASSED

- `tests/integration/guard/intercept-all-commands.test.ts` exists ✓ (16 tests, 214 lines)
- `tests/integration/guard/consistent-read.test.ts` exists ✓ (2 tests, 186 lines)
- `tests/integration/guard/cache-ttl.test.ts` exists ✓ (4 tests, 167 lines)
- `tests/integration/guard/fail-closed.test.ts` exists ✓ (1 test, 104 lines)
- `tests/integration/guard/block-mode.test.ts` exists ✓ (3 tests, 116 lines)
- Commit `81fdcca` (Task 1) exists in `git log` ✓
- Commit `d27c022` (Task 2) exists in `git log` ✓
- `pnpm typecheck` exits 0 ✓
- `pnpm test` (full unit suite) → 591/591 passing ✓ (unchanged from Plan 05)
- `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/guard/` → 26/26 passing across 5 files in ~1.4 s ✓
- `pnpm exec vitest run --config vitest.integration.config.ts` (full integration suite) → 28/28 passing across 7 files (5 new + 2 spike) ✓
- `pnpm exec biome check ./tests/integration/guard/` exits 0 ✓
- No stub patterns (`TODO`, `FIXME`, `placeholder`) in any new file ✓
- No production source modified — plan declared `files_modified` only under `tests/integration/guard/` ✓
- Both tests gate on `isDdbLocalReachable()` ✓
- BLD-04 cornerstone test contains TWO `it` blocks (UNSAFE-PATH + SAFE-PATH) ✓
- Pitfall #3 matrix covers BOTH `DynamoDBClient` (raw) AND `DynamoDBDocumentClient` ✓

---

*Phase: 03-internal-entities-lock-guard*
*Completed: 2026-05-08*
