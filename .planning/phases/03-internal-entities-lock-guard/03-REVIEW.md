---
phase: 03-internal-entities-lock-guard
reviewed: 2026-05-08T16:13:50Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - src/guard/cache.ts
  - src/guard/classify.ts
  - src/guard/index.ts
  - src/guard/lock-state-set.ts
  - src/guard/wrap.ts
  - src/internal-entities/index.ts
  - src/internal-entities/migration-runs.ts
  - src/internal-entities/migration-state.ts
  - src/internal-entities/migrations.ts
  - src/internal-entities/service.ts
  - src/internal-entities/types.ts
  - src/lock/acquire.ts
  - src/lock/heartbeat.ts
  - src/lock/index.ts
  - src/lock/read-lock-row.ts
  - src/lock/stale-cutoff.ts
  - src/lock/unlock.ts
  - src/state-mutations/acquire.ts
  - src/state-mutations/append-in-flight.ts
  - src/state-mutations/cancellation.ts
  - src/state-mutations/clear.ts
  - src/state-mutations/heartbeat.ts
  - src/state-mutations/index.ts
  - src/state-mutations/mark-failed.ts
  - src/state-mutations/transition.ts
  - src/state-mutations/unlock.ts
  - tests/_helpers/clock.ts
  - tests/_helpers/source-scan.ts
  - tests/integration/_helpers/concurrent-acquire.ts
  - tests/integration/_helpers/ddb-local.ts
  - tests/integration/_helpers/docker-availability.ts
  - tests/integration/_helpers/eventual-consistency.ts
findings:
  critical: 4
  warning: 6
  info: 4
  total: 14
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-05-08T16:13:50Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

Phase 3 ships the load-bearing concurrency moat — internal entities, lock subsystem, guard middleware, and the state-mutation verbs. The architecture is sound (centralised consistent-read, named-import marker, in-flight read dedup, fail-closed cache, A7-correct gating set, no `setInterval` in `src/`), but the implementation contains four BLOCKER-class defects that compromise the "no silent corruption" core guarantee:

1. The `is/extractResultCancellationReason` helpers only inspect transactWrite `data[0]`. For multi-item transactions (`acquire`, `transition`, `markFailed`), a cancellation rooted at item 1 or item 2 is silently swallowed — the verb returns success while no rows were written.
2. `state-mutations/clear` does not delete the cleared `migId` from `releaseIds`. Every successful `clear` leaves stale residue in the set; the lock-row state diverges from reality across migration cycles.
3. `state-mutations/markFailed` does not delete `migId` from `inFlightIds`. After a failure, the lock-row carries the same migId in BOTH `inFlightIds` AND `failedIds`, contradicting the documented invariant that `inFlightIds` only holds migrations "currently being applied".
4. `lock/heartbeat.ts` `onAbort` discards the `markFailed` promise via `void`. If `markFailed` rejects (e.g. lock already taken over), the rejection is unhandled — a hard process crash on Node 15+ defaults.

In addition, the cache thaw guard (Pitfall #2) is documented but not actually implemented (the `<= 2× TTL` clause is vacuous), and several JSDoc claims diverge from code (gating set in `EDBMigrationInProgressError`, `lastHeartbeatAt` write set in `_migration_runs`).

## Critical Issues

### CR-01: `isResultConditionalCheckFailed` only inspects item 0 — item 1/2 cancellations are silently swallowed

**File:** `src/state-mutations/cancellation.ts:125-129` (helper); used by `src/state-mutations/acquire.ts:119`, `src/state-mutations/transition.ts:85`, `src/state-mutations/clear.ts:51`, `src/state-mutations/mark-failed.ts:62`
**Issue:**

ElectroDB v3 surfaces a canceled `transactWrite` as `{canceled: true, data: [...]}`. AWS SDK's `CancellationReasons` is parallel-indexed to the input items: when item N's condition fails, `data[N].rejected = true` and the OTHER items get `Code: 'None'`. The current helper checks ONLY `data[0]`:

```ts
export function isResultConditionalCheckFailed(result: TransactionWriteResult): boolean {
  if (!result.canceled) return false;
  const item0 = result.data?.[0];
  return item0?.rejected === true && item0.code === 'ConditionalCheckFailed';
}
```

For `transition` (3 items) and `markFailed` (2 items), item 1 / item 2 are `.patch(...)` calls on `_migrations` and `_migration_runs` that carry ElectroDB's implicit `attribute_exists(pk)` row-existence check. If those rows are missing (programmer error in Phase 4 wiring, or a schema-drift race), the cancellation reason lands on item 1 or 2 — `result.canceled === true` but `data[0].rejected === false`. The helper returns `false`, the verb returns success, and **no rows are written** because transactWrite is all-or-nothing.

Concrete failure scenario for `transition`:
1. Runner calls `transition({runId, migId, outcome: 'applied'})`.
2. The `_migrations` row for `migId` is missing (e.g. Phase 4 forgot to write the `pending` baseline first).
3. Item 1 (`migrations.patch({id: migId})`) fails its implicit `attribute_exists` — the whole transactWrite is canceled.
4. `result = {canceled: true, data: [{rejected: false, code: 'None'}, {rejected: true, code: 'ConditionalCheckFailed'}, {rejected: false, code: 'None'}]}`.
5. `isResultConditionalCheckFailed(result) → false`. Verb returns success.
6. The lock is still in `apply` state. The runner believes the transition succeeded and proceeds to the next migration. The heartbeat scheduler keeps the stuck `apply` lock alive indefinitely.

This breaks the framework's core "no silent corruption" guarantee — a runner can write data thinking the audit trail and lock state were updated when in fact nothing was committed.

`acquire` is partially insulated by `acquireLock`'s read-back verify (`src/lock/acquire.ts:48-55`), but `transition`, `clear` (1 item — fine here, only `data[0]` exists), and `markFailed` have no read-back verify and would propagate the silent failure.

**Fix:**
Either inspect ALL items, or treat any `result.canceled === true` as a failure:

```ts
// Option A — minimal: any cancellation is a failure
export function isResultConditionalCheckFailed(result: TransactionWriteResult): boolean {
  return result.canceled === true;
}

// Option B — find the actually-rejected item
export function findRejectedItem(result: TransactionWriteResult): { index: number; code: string; item?: Record<string, unknown> } | null {
  if (!result.canceled) return null;
  const data = result.data ?? [];
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    if (d?.rejected === true) {
      const reason: { index: number; code: string; item?: Record<string, unknown> } = { index: i, code: d.code ?? 'Unknown' };
      if (d.item) reason.item = d.item;
      return reason;
    }
  }
  return null;
}
```

Update each verb's call site to use the new shape, and refine the thrown error message to surface `index` so the operator knows whether the lock row, migrations row, or runs row was the rejector.

---

### CR-02: `clear` does not remove the cleared `migId` from `releaseIds` — stale set residue accumulates

**File:** `src/state-mutations/clear.ts:40-49`
**Issue:**

`transitionToReleaseMode` adds the `migId` to `releaseIds` (line 64) when flipping to release-mode. The complementary `clear` verb is supposed to "free" the lock for that migId — but the patch only flips `lockState='free'` and removes the lock-holder fields:

```ts
.set({ lockState: 'free', updatedAt: now })
.remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt'])
```

`releaseIds` is never touched. After every successful `apply → release → clear` cycle, one stale migId remains in `releaseIds` forever. Over a project's lifetime, `releaseIds` grows unbounded and no longer reflects "migrations whose release call hasn't happened yet" (the documented semantic in `migration-state.ts:18-23`).

Consequences:
- The `status` command in Phase 4 will surface phantom pending releases.
- A future invariant or `validate` rule that checks `releaseIds === ∅` for a `free` lock will fire false positives forever.
- DynamoDB item size grows linearly with the number of past migrations until it hits the 400 KB item-size limit.

**Fix:**

```ts
.set({ lockState: 'free', updatedAt: now })
.delete({ releaseIds: [/* the migId the runId released */] })
.remove(['lockHolder', 'lockRunId', 'lockMigrationId', 'lockAcquiredAt', 'heartbeatAt'])
```

`clear` currently has no `migId` argument. Either thread it through `ClearArgs`, or read the lock row first to learn which migId this runId released and `delete({ releaseIds: [thatMigId] })` from the patch — note that the latter introduces a read+write race that the current single-transactWrite path avoids, so threading the migId through `ClearArgs` is the safer fix. Since `lockMigrationId` is already known to the runner by acquisition time, this is a one-line change for callers.

---

### CR-03: `markFailed` leaves `migId` in `inFlightIds` after marking failed

**File:** `src/state-mutations/mark-failed.ts:43-48`
**Issue:**

`acquire` adds `migId` to `inFlightIds` (line 76 of acquire.ts). The complementary failure path in `markFailed` adds `migId` to `failedIds` but does NOT delete it from `inFlightIds`:

```ts
const stateOp = migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: 'failed', heartbeatAt: now, updatedAt: now });
const stateWithAdd = args.migId ? stateOp.add({ failedIds: [args.migId] }) : stateOp;
```

After a failure, the migId appears in BOTH sets. The schema docstring says `inFlightIds` is "migrations currently being applied/finalized/rolled back" (`migration-state.ts:13-15`) — a `failed` migration is no longer "currently" doing anything. The `failed` state means the run aborted; nothing is in-flight.

Consequences:
- Future invariant checks that assume `inFlightIds` is empty in non-active lockStates will fire.
- A subsequent `acquire(rollback)` for the same migId will succeed with item 0's takeover branch (lockState ∈ {apply, rollback, finalize, dying} — but `failed` is not in the takeover allowlist, so this acquire requires `unlock` first; once unlocked, the `acquire` adds `migId` to `inFlightIds` AGAIN — DDB set semantics mean the dup is silently merged, but the fact that we passed through `failed` without cleaning up is still a bug).
- `inFlightIds` grows indefinitely across repeated failures.

**Fix:**

```ts
const stateOp = migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: 'failed', heartbeatAt: now, updatedAt: now });
const stateWithIds = args.migId
  ? stateOp.add({ failedIds: [args.migId] }).delete({ inFlightIds: [args.migId] })
  : stateOp;
```

---

### CR-04: `lock/heartbeat.ts` `onAbort` fires a discarded promise — unhandled rejection on `markFailed` failure

**File:** `src/lock/heartbeat.ts:28-34`
**Issue:**

```ts
onAbort: (err) => {
  void markFailed(args.service, {
    runId: args.runId,
    ...(args.migId !== undefined ? { migId: args.migId } : {}),
    cause: err,
  });
},
```

`markFailed` returns a `Promise<void>` and CAN reject — the verb explicitly throws `EDBMigrationLockHeldError` when the conditional check fails (`mark-failed.ts:62-70`). The `void` operator discards the promise without attaching a handler. If `markFailed` rejects (likely scenario: the heartbeat aborted because someone else took over the lock; the takeover means `markFailed`'s `lockRunId = :runId` condition will fail), the rejection becomes unhandled.

Node 15+ default behaviour is to crash the process on unhandled promise rejection (`--unhandled-rejections=throw` is the default). In a long-running server using this framework, a single Lambda-class abort path could take down the whole host process.

The path is reachable because the abort scenario is exactly the scenario where `markFailed` fails: heartbeats abort because the runner lost the lock; the runner has lost the lock because someone else took over; `markFailed`'s runId pin then rejects.

**Fix:**

```ts
onAbort: (err) => {
  markFailed(args.service, {
    runId: args.runId,
    ...(args.migId !== undefined ? { migId: args.migId } : {}),
    cause: err,
  }).catch((markFailedErr) => {
    // Heartbeat abort + concurrent takeover is the expected failure mode.
    // We have already lost the lock; surfacing this further is the runner's job.
    // Surface for diagnostic visibility but do not let it become unhandled.
    // Phase 4's runner installs an `onMarkFailedError` listener if it cares.
    // A plain console.error keeps Phase 3 self-contained.
    // eslint-disable-next-line no-console
    console.error('electrodb-migrations: markFailed failed during heartbeat-abort path', markFailedErr);
  });
},
```

(Alternatively, expose an `onMarkFailedError` callback through `StartLockHeartbeatArgs`.) The minimum requirement is that the rejection MUST be observed.

---

## Warnings

### WR-01: Cache thaw-guard (Pitfall #2) is documented but not implemented

**File:** `src/guard/cache.ts:55-59` (JSDoc) vs `src/guard/cache.ts:71-76` (code)
**Issue:**

The JSDoc claims a Lambda thaw guard:

> When `(now - cachedAt) > cacheTtlMs * 2`, forces a re-read. Handles the case where a frozen process resumes after the cache TTL has wall-clock elapsed but a timer-based TTL would NOT have fired.

The code:

```ts
if (cached && now - cached.cachedAt < opts.cacheTtlMs && now - cached.cachedAt <= opts.cacheTtlMs * 2) {
  return cached.value;
}
```

The second clause `<= cacheTtlMs * 2` is mathematically vacuous: it is true whenever the first clause `< cacheTtlMs` is true. The cache uses `Date.now()` as its only time source, so a frozen-then-thawed process automatically observes a stale `cached.cachedAt` and the FIRST clause fires the re-read. The thaw guard is effectively the standard wall-clock TTL, not a defense-in-depth `2× TTL` upper bound.

This is fine FOR CORRECTNESS — the cache does fail-closed-on-thaw because Date.now() is wall-clock — but the intent expressed in the JSDoc and the inline comment ("Pitfall #2 defense: fresh-cached AND age <= 2× TTL") does not match the code. Either drop the second clause and update the JSDoc, or implement what the JSDoc says (e.g. a separate force-refresh-when-clearly-thawed branch that resets `pending` if the gap is very large).

**Fix:**

Remove the dead clause and rewrite the comment to match what the code actually does:

```ts
// Wall-clock TTL via Date.now() — survives Lambda freeze/thaw because the
// elapsed-time test sees real time, not virtual time. (Pitfall #2.)
if (cached && now - cached.cachedAt < opts.cacheTtlMs) {
  return cached.value;
}
```

Or, if the intent of the `2×` upper bound was a defense against a clock-skew bug (`cachedAt` being IN THE FUTURE due to NTP step), state that explicitly and check `cached.cachedAt <= now`.

---

### WR-02: `wrapClient` is not idempotent — duplicate registration on the same client double-stacks middleware

**File:** `src/guard/wrap.ts:56-76`
**Issue:**

```ts
args.client.middlewareStack.add(
  (next, context) => async (rawArgs) => { /* ... */ },
  { step: 'initialize', name: 'electrodb-migrations-guard' },
);
```

If `wrapClient` is invoked twice on the same client (e.g. in a test harness, or by user code that constructs the framework twice in the same process), two middlewares are registered with the same name. AWS SDK v3's middleware stack does NOT enforce name uniqueness — both will run, each issuing a `cache.get()` call (the cache is shared between the two middlewares because they each reference different cache closures), and on a guarded state both will throw — but the FIRST throw is what propagates, and the second middleware's read is wasted.

If a user provides their own pre-existing client with similar middleware naming, no collision detection.

**Fix:**

Add an idempotency check via a Symbol stamped on the client:

```ts
const STAMP = Symbol.for('electrodb-migrations-guard-installed');
type StampedClient = (DynamoDBClient | DynamoDBDocumentClient) & { [STAMP]?: true };

export function wrapClient(args: WrapClientArgs) {
  const c = args.client as StampedClient;
  if (c[STAMP]) return c;
  // ... existing registration ...
  Object.defineProperty(c, STAMP, { value: true, enumerable: false, configurable: false });
  return c;
}
```

---

### WR-03: `EDBMigrationInProgressError` JSDoc lists `finalize` in the gating set but `GATING_LOCK_STATES` excludes it

**File:** `src/errors/classes.ts:14-18`
**Issue:**

The error class JSDoc says:

> Thrown by the migration guard when app traffic hits a guarded client while the lock is in `{apply, finalize, rollback, release, failed, dying}`.

But `src/guard/lock-state-set.ts` (per Decision A7) explicitly excludes `finalize`:

```
{ 'apply', 'rollback', 'release', 'failed', 'dying' }
```

A reader of the error class will get the wrong mental model of when this error fires. Since the WAVE0-NOTES Decision A7 explicitly says "Phase 3 commits MUST NOT silently rewrite REQUIREMENTS.md GRD-04 wording" and treats this as a documentation-debt item to be resolved later, the error class JSDoc should be updated to match the truth (or to at least flag the contradiction).

**Fix:**

Update the JSDoc to reflect `GATING_LOCK_STATES`:

```ts
/**
 * Thrown by the migration guard when app traffic hits a guarded client while
 * the lock is in `{apply, rollback, release, failed, dying}`. Note that
 * `finalize` is intentionally NOT gated — see WAVE0 Decision A7 and
 * `src/guard/lock-state-set.ts`.
 *
 * Documented in README §9.3. User code uses `isMigrationInProgress(err)`.
 */
```

---

### WR-04: `migration-runs.ts` JSDoc for `lastHeartbeatAt` claims acquire updates it, but acquire does not

**File:** `src/internal-entities/migration-runs.ts:58-66` (JSDoc) vs `src/state-mutations/acquire.ts:86-96` (code)
**Issue:**

The schema doc says:

> Last heartbeat timestamp written by the runner during this run. Updated on every state transition (acquire, transition-to-release, mark-failed) and on final completion.

But the `acquire` verb's `migrationRuns.put(...)` payload does NOT include `lastHeartbeatAt`:

```ts
migrationRuns.put({
  runId: args.runId,
  command: args.mode,
  status: 'running',
  migrationId: args.migId,
  startedAt: now,
  startedBy: args.holder,
  schemaVersion: MIGRATION_RUNS_SCHEMA_VERSION,
}).commit(),
```

So `lastHeartbeatAt` is `undefined` until the run completes (transition or markFailed). For an in-progress run, `getRunStatus(runId)` would have to fall back to the `_migration_state.heartbeatAt` cross-row read that the field was supposed to eliminate.

Either:
- Update `acquire` to include `lastHeartbeatAt: now` in the put (small, cheap), OR
- Update the JSDoc to drop the "(acquire ...)" claim and clarify that `lastHeartbeatAt` is only populated on terminal states.

The migration-runs.ts JSDoc later says "Phase 9's `getRunStatus(runId)` reads this single row AFTER the run completes" — which suggests the second reading is correct. In that case, fix the JSDoc.

**Fix:**

```ts
/**
 * Last heartbeat timestamp written into `_migration_runs` at terminal-state
 * transitions only — `transition-to-release` (success), `mark-failed`
 * (abort). NOT updated during the run; the live heartbeat lives on
 * `_migration_state.heartbeatAt`. Phase 9's `getRunStatus(runId)` reads
 * this row only after the run has completed; for in-progress runs callers
 * must read `_migration_state` directly.
 */
lastHeartbeatAt: { type: 'string' },
```

---

### WR-05: `tests/_helpers/source-scan.ts` reports wrong line numbers when `stripComments: true`

**File:** `tests/_helpers/source-scan.ts:24-37` + `45-56`
**Issue:**

`stripCommentLines` filters out (removes entirely) any line whose trimmed prefix is `//`, `/*`, or `*`:

```ts
return src.split('\n').filter((line) => {
  const t = line.trim();
  if (t.startsWith('//')) return false;
  if (t.startsWith('/*')) return false;
  if (t.startsWith('*')) return false;
  return true;
}).join('\n');
```

After stripping, subsequent lines shift up. The scan loop then reports `line: i + 1` where `i` is the index in the FILTERED array — not the line number in the original file. So when a developer fails the source-scan test (e.g. `consistent: true` literal found at original-file line 47 with three comments before it), the test reports a misleading line (e.g. line 44).

The single in-tree caller that uses `stripComments: true` is `tests/unit/lock/source-scan.test.ts:65`, which today asserts an EMPTY result — when it passes, line numbers are irrelevant. But the moment a violation is introduced, the diagnostic surface lies to the developer about WHERE the violation is.

**Fix:**

Replace the line-removing filter with a line-blanking transform that preserves line indexing:

```ts
export const stripCommentLines = (src: string): string => {
  return src
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return '';
      return line;
    })
    .join('\n');
};
```

Empty lines never match the predicates the scanners use, so this preserves correctness while making line numbers meaningful.

---

### WR-06: `markFailed`'s error.message has no length bound — could exceed DDB item-size limits

**File:** `src/state-mutations/mark-failed.ts:84-95`
**Issue:**

`serializeCause` writes `cause.message` directly into the `_migration_runs.error.message` attribute without any truncation:

```ts
return { code, message: c.message };
```

DynamoDB item-size limit is 400 KB. If the underlying error is a deeply-nested AWS SDK error or a TypeScript stack trace that has been stuffed into `.message`, this could push the run row over the limit. The transactWrite would fail at item 1 with a non-condition error code (likely `ValidationException`), and per CR-01, the verb would silently return success.

This is unlikely in practice but trivial to defend against.

**Fix:**

Cap the message length. 8 KB is plenty for diagnostic surface and leaves room for the rest of the run row:

```ts
const MAX_MESSAGE_LEN = 8 * 1024;
const message = c.message.length > MAX_MESSAGE_LEN ? c.message.slice(0, MAX_MESSAGE_LEN) + '... (truncated)' : c.message;
return { code, message };
```

---

## Info

### IN-01: `acquire` re-throws raw `TransactionCanceledException` after the catch — keeps two parallel diagnostic paths

**File:** `src/state-mutations/acquire.ts:99-117` and `:119-130`
**Issue:**

`acquire` is the only verb that has BOTH a try/catch on the SDK-throws path AND a result-shape inspection on the ElectroDB-doesn't-throw path. The duplication is documented as defense-in-depth. Long-term, it would be cleaner to eliminate one path once the recently-applied result-shape branch (commits 84f6b91 + caf1588) has been validated under both ElectroDB-direct and SDK-direct paths.

Not a defect; flagged for future consolidation.

**Fix:** Delete the catch branch once Phase 6+ integration tests prove ElectroDB v3 always surfaces cancellations as `{canceled: true, data: ...}`. Until then, leaving the catch in place is defensive.

---

### IN-02: `state-mutations/index.ts` exports `extractCancellationReason` and `isConditionalCheckFailed` but not the result-shape variants

**File:** `src/state-mutations/index.ts:10-14`
**Issue:**

```ts
export {
  isConditionalCheckFailed,
  extractCancellationReason,
  type CancellationReason,
} from './cancellation.js';
```

The `*Result*` variants are used internally by every verb but never exported. If they're truly internal-only, fine — but the asymmetry suggests the throws-path variants leaked into the public surface area unintentionally. Confirm whether the throws-path variants are intentionally part of the public API for Phase 4's runner; if not, either export the result-shape variants too or stop exporting the throws-path variants.

**Fix:** Decide on the public surface in Phase 4 and align.

---

### IN-03: `seedLockRow` is documented as Wave-0-only but still exported alongside `bootstrapMigrationState`

**File:** `tests/integration/_helpers/ddb-local.ts:88-110`
**Issue:**

The JSDoc explicitly says Wave 0 spike-only convenience and that "tests should prefer the Service path" (`bootstrapMigrationState`). Both helpers are still exported with no deprecation surface. New tests may pick the wrong helper.

**Fix:** Either delete `seedLockRow` (Wave 0 spike tests live under `tests/integration/_spike/` and could be the only callers) or rename it to make the test-only nature obvious (e.g. `unsafeSeedLockRowRaw`). Marking with `@deprecated` JSDoc would also work.

---

### IN-04: `acquire` `attribute_not_exists(lockState)` branch is unreachable in production

**File:** `src/state-mutations/acquire.ts:78-79`
**Issue:**

The acquire ConditionExpression starts with `attribute_not_exists(lockState) OR ...`. Because `lockState` is declared `required: true` in the entity schema, it is always present whenever the row exists. ElectroDB's `.patch()` carries an implicit `attribute_exists(pk) AND attribute_exists(sk)` check (per the `bootstrapMigrationState` docstring), so a fresh-table `acquire` against a never-bootstrapped row will fail with `ConditionalCheckFailed` from the IMPLICIT row-existence check before the `attribute_not_exists(lockState)` branch can possibly match.

This means the branch is effectively dead code in production. The framework relies on a separate `init` step (Phase 1's `validateConfigInvariants`-adjacent bootstrap, or the test helper) to seed the row before any `acquire` runs.

Not a bug today, but worth a JSDoc note so the next reader doesn't get confused about why `acquire` would fail on a brand-new table.

**Fix:** Add a one-line JSDoc note to acquire.ts explaining that the `attribute_not_exists(lockState)` branch is defensive against a hypothetical row-existence-without-lockState state and that production paths require `init` to bootstrap the row first.

---

_Reviewed: 2026-05-08T16:13:50Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
