---
phase: 04-apply-release-finalize-runner
reviewed: 2026-05-09T00:00:00Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - src/cli/commands/apply.ts
  - src/cli/commands/finalize.ts
  - src/cli/commands/history.ts
  - src/cli/commands/release.ts
  - src/cli/commands/status.ts
  - src/cli/index.ts
  - src/cli/program.ts
  - src/client/create-migrations-client.ts
  - src/client/index.ts
  - src/client/types.ts
  - src/guard/index.ts
  - src/guard/wrap.ts
  - src/index.ts
  - src/migrations/index.ts
  - src/runner/apply-batch.ts
  - src/runner/apply-flow.ts
  - src/runner/apply-summary.ts
  - src/runner/finalize-flow.ts
  - src/runner/history-format.ts
  - src/runner/index.ts
  - src/runner/load-migration-module.ts
  - src/runner/load-pending.ts
  - src/runner/scan-pipeline.ts
  - src/runner/sleep.ts
  - src/runner/transition-release-to-apply.ts
  - src/state-mutations/clear-finalize.ts
  - src/state-mutations/index.ts
findings:
  blocker: 4
  warning: 11
  total: 15
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-05-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 27
**Status:** issues_found

## Summary

Phase 4 ships the apply / release / finalize runner — the data-path execution layer where the project's core safety value ("a migration on a live DynamoDB table cannot silently corrupt data") lives or dies. The implementation is largely faithful to the design (lock state machine, runUnguarded bypass, ConsistentRead reuse, count-audit invariant) but contains four blocker-class defects and a number of correctness/quality warnings.

The most serious finding is BL-01: `applyFlowScanWrite` writes the `_migrations` audit row **twice** in a row — once via `upsert` and again via `put` — with subtly different field sets. The second write **overwrites** any `reads` set established by the first, and the first write's `fingerprint: 'applied:<id>'` is squashed by the second's `fingerprint: ''`. This is dead-on a copy-paste/merge artifact and ships incorrect audit-row contents on every successful apply.

The remaining blockers cover: a no-pending-migrations bug in `apply` that emits a misleading success summary; an unrecoverable type-cast that silently dereferences nullable model fields and crashes if a migration file shape drifts; and a sort comparator that violates JavaScript's "stable on equal keys" contract (rare-impact, but produces non-deterministic ordering on duplicate ids).

Warnings span: silent error swallowing in migration discovery, fragile substring-based `ConditionalCheckFailedException` detection, undocumented smithy `middlewareStack.clone()` usage, missing directory filtering during disk walk, semantic confusion in finalize's reuse of the `migrated` count slot as "deleted", inconsistent stderr output between client and CLI, and `unknown` casts that bypass type safety on critical paths.

## Critical Issues

### BL-01: `applyFlowScanWrite` writes the `_migrations` row twice; second write overwrites first

**File:** `src/runner/apply-flow.ts:97-152`
**Issue:** Within `applyFlowScanWrite`, the `_migrations` audit row is created with **two** sequential writes to the same primary key:

1. Lines 103-119 — `upsert(...)` with `fingerprint: 'applied:<id>'` and `kind: 'transform'`. No `reads` set.
2. Lines 136-152 — `put(...)` with `fingerprint: ''` (placeholder) and conditionally a `reads: new Set(...)` field.

This appears to be a merge / copy-paste artifact: both blocks claim to be "the create the row before patching" step but they're functionally redundant. The second `put` overwrites the entire row including the first write's `fingerprint`. The net effect is:
- `fingerprint` ends up as `''` (empty string) instead of the placeholder `'applied:<id>'` — operationally the same, but the JSDoc claim that the upsert sets a placeholder is a lie at runtime.
- `kind: 'transform'` is set in both, fine.
- `hasDown` and `hasRollbackResolver` are set in the first write whenever the migration object has them; in the second write they are conditional spreads. If the second write omits them when they would be `false`, prior `false` settings from the first write survive — and the first write writes `false` literally (`typeof down === 'function'` evaluating to `false`). Inconsistent behavior depending on which path won.
- `reads` is only set in the second write. If the second write succeeds, `reads` is present; if both writes succeed (the normal case), `reads` is present and correct.
- Two extra round trips to DynamoDB per migration, contributing extra write-throttle pressure on the lock-row partition.

This is a correctness bug because the post-apply audit row depends on `fingerprint` being the placeholder `'applied:<id>'` per JSDoc claim, but ships the empty string. Phase 7's `validate` gate writes the real fingerprint, but a half-migrated state (apply succeeded, validate not yet run) is observable through `history --json` with `fingerprint: ''` — surprising operators who debug from the audit log.

**Fix:** Delete the first `upsert` block (lines 102-119). Keep only the `put` block (lines 134-152). Verify the JSDoc paragraph at lines 92-95 is accurate after the fix; the row-existence-before-patch invariant is upheld by the remaining `put`.

```typescript
// REMOVE lines 102-119 entirely. Keep only:
const fromVersion = (args.migration.from as unknown as { model: { version: string } }).model.version;
const toVersion = (args.migration.to as unknown as { model: { version: string } }).model.version;
await args.service.migrations
  .put({
    id: args.migration.id,
    schemaVersion: MIGRATIONS_SCHEMA_VERSION,
    kind: 'transform',
    status: 'pending',
    entityName: args.migration.entityName,
    fromVersion,
    toVersion,
    fingerprint: '',
    ...(args.migration.down !== undefined ? { hasDown: true } : {}),
    ...(args.migration.rollbackResolver !== undefined ? { hasRollbackResolver: true } : {}),
    ...(args.migration.reads !== undefined && args.migration.reads.length > 0
      ? { reads: new Set(args.migration.reads.map((e) => (e as unknown as { model: { entity: string } }).model.entity)) }
      : {}),
  } as never)
  .go();
```

---

### BL-02: `apply` emits misleading "success" summary when no migrations applied

**File:** `src/client/create-migrations-client.ts:158-175` and `src/cli/commands/apply.ts:64-67`
**Issue:** When `result.applied.length === 0`, the client correctly skips the summary write (line 158 conditional). However the CLI's `runApply` then calls `spinner.stop()` followed by `log.info('No migrations to apply.')` and returns. Behavior is correct here.

The bug is subtler: when `apply` is called with `migrationId` and the migration has already been applied (so `pending` excludes it), `applyBatch` returns `{ applied: [] }` silently. The CLI prints "No migrations to apply.", but the operator's intent was to apply a SPECIFIC migration. They will reasonably interpret the message as "the system is up to date" when in fact their target was rejected by silent filtering. There is no error — `applyBatch` only throws `EDB_NOT_NEXT_PENDING` / `EDB_NOT_PENDING` when the id IS in pending list but in the wrong slot. If the id is not even in `pending` (already applied, never existed, etc.), it returns `{applied: []}`.

Trace:
1. `runApply` is called with `migrationId: '20260509-User-add-status'`.
2. `resolvePendingMigrations` returns `[]` (migration already applied → `_migrations.status='applied'` → filtered out).
3. `applyBatch` line 69: `args.pending.length === 0 → return { applied: [] }`. The `migrationId` is never inspected.
4. CLI prints "No migrations to apply.", exits 0.

The operator gets no signal that their explicit target was a no-op. This is data-loss adjacent because they may then re-run `apply` thinking nothing happened, or skip the next required step.

**Fix:** In `applyBatch` at line 69, distinguish the no-op cases. If `args.migrationId` is set and `args.pending.length === 0`, throw `EDB_NOT_PENDING` with an informative remediation rather than silently returning empty:

```typescript
// RUN-07
if (args.pending.length === 0) {
  if (args.migrationId !== undefined) {
    const err: Error & { code?: string; remediation?: string } = new Error(
      `Migration '${args.migrationId}' is not pending (already applied, finalized, failed, or unknown).`,
    );
    err.code = 'EDB_NOT_PENDING';
    err.remediation = 'Run `electrodb-migrations history` to inspect this migration\'s current status.';
    throw err;
  }
  return { applied: [] };
}
```

---

### BL-03: `transitionReleaseToApply` lacks `migId` write — `lockMigrationId` from prior migration leaks into next

**File:** `src/runner/transition-release-to-apply.ts:33-45` (cross-referenced with `src/runner/apply-batch.ts:120-130`)
**Issue:** `transitionReleaseToApply` only sets `{ lockState: 'apply', heartbeatAt, updatedAt }`. It does NOT update `lockMigrationId`. The JSDoc at lines 5-8 acknowledges this and claims `appendInFlight` is responsible for advancing it.

`appendInFlight` (state-mutations/append-in-flight.ts) does set `lockMigrationId: args.migId`. **However**, the call order in `apply-batch.ts:128-130` is:

```typescript
await appendInFlight(args.service, { runId, migId: next.id });        // (1) sets lockMigrationId = next.id, lockState still 'release'
await transitionReleaseToApply(args.service, { runId, migId });        // (2) flips lockState = 'apply'
```

This is correct. **However**, `transitionReleaseToApply`'s `args.migId` parameter (line 11, line 130) is accepted but unused. The JSDoc says "carried for call-site symmetry" and "not read by this verb". Two concerns:

1. **Code-smell signal masking a real defect:** if a future maintainer reorders the `appendInFlight` and `transitionReleaseToApply` calls to "transition first, then update lockMigrationId for the next migration", the lock will briefly show `lockState='apply'` with `lockMigrationId` pointing at the PRIOR (just-released) migration. The guard's `EDBMigrationInProgressError` would surface the wrong migId to app traffic. The unused-parameter shape provides no compile-time defense.

2. **The condition expression at line 41-43** filters on `lockRunId = :runId AND lockState = 'release'` but does NOT verify `lockMigrationId = :migId`. If an operator sneaks in a manual patch between `appendInFlight` and `transitionReleaseToApply`, the transition will succeed under stale assumptions. Low realistic risk, but the safety wrapper's whole point is defense in depth.

**Fix:** Either (a) tighten the contract by removing the unused parameter and updating callers + JSDoc, OR (b) include `lockMigrationId = :migId` in the WHERE clause and use the parameter for what it's named:

```typescript
// Option B — use the parameter for runtime defense:
await service.migrationState
  .patch({ id: MIGRATION_STATE_ID })
  .set({ lockState: 'apply', heartbeatAt: now, updatedAt: now })
  .where(({ lockRunId, lockState, lockMigrationId }, op) =>
    `${op.eq(lockRunId, args.runId)} AND ${op.eq(lockState, 'release')} AND ${op.eq(lockMigrationId, args.migId)}`,
  )
  .go();
```

Pick A or B; the current state of "accept but ignore" is a footgun.

---

### BL-04: `finalize` `--all` silently skips applied migrations whose source files vanished

**File:** `src/client/create-migrations-client.ts:218-227`
**Issue:** In the `finalize({ all: true })` loop, when `migrationObj` cannot be resolved (deleted from disk, renamed, etc.), the code does `continue` (line 227 — `// migration not found — skip (operator alert)`). The comment claims "operator alert" but no log, exception, or returned-result entry is emitted.

This is a data-integrity issue. The user ran `finalize --all` to clean up v1 records for **every applied migration**. The framework silently leaves some untouched. The result `{ finalized: [...] }` only contains the ones that succeeded — the user has no signal that finalization was incomplete. They will then deploy the next code release thinking v1 is gone, and v1 records remain in the table, possibly causing scan-side surprises (e.g. ElectroDB's identity-stamp filtering means they're hidden from v2 reads, but they consume storage and will reappear if anyone runs a raw scan or rebuilds an index).

The README §1 contract is explicit: a migration cannot leave a table in a half-migrated state without explicit operator action. `finalize --all` silently skipping a subset is a half-finalized state without operator action.

**Fix:** Either log a warning OR throw on missing migration sources:

```typescript
if (!migrationObj) {
  // Throw — silent skip violates the "no half-migrated state without operator action" contract.
  const err: Error & { code?: string; remediation?: string } = new Error(
    `finalize --all: migration source for '${row.id}' is not available on disk or in the preloaded migrations array.`,
  );
  err.code = 'EDB_MIGRATION_SOURCE_MISSING';
  err.remediation = `Restore the migration source under '${args.config.migrations}/${row.id}' or pass it via the 'migrations' option, then re-run.`;
  throw err;
}
```

If the project decides "skip is acceptable", then return-shape MUST include a `skipped: ['<id>', ...]` array so the operator can inspect what was not finalized; the README's audit-trail commitment is broken without it.

## Warnings

### WR-01: `loadPendingMigrations` swallows ALL errors during migration-file evaluation

**File:** `src/runner/load-pending.ts:93`
**Issue:** `const mig = await loadMigrationFile(migPath).catch(() => null);` silently swallows `EDBMigrationLoadError` (from `load-migration-module.ts:42`) — including syntax errors, type errors at evaluation time, missing imports, and any other compilation failure. The user gets `[]` from `loadPendingMigrations`, which the CLI translates to "No migrations to apply."

Justification in the comment ("validate gate (Phase 7) is the appropriate reporter") is a deferred-justification antipattern. Phase 4 ships this code; Phase 7 hasn't shipped. In practice today, an operator with a broken migration file gets a misleading "all clear" message.

**Fix:** Surface load errors at minimum as a stderr warning, ideally as a thrown error so the runner refuses to apply when it can't enumerate. Pattern:

```typescript
const mig = await loadMigrationFile(migPath).catch((err: unknown) => {
  // Surface, do not swallow. The caller (apply / status / etc.) needs to know.
  process.stderr.write(`[electrodb-migrations] Failed to load ${migPath}: ${err instanceof Error ? err.message : String(err)}\n`);
  return null;
});
```

Better: throw and let `apply` fail closed.

---

### WR-02: `loadPendingMigrations` does not filter non-directory entries before treating them as migrations

**File:** `src/runner/load-pending.ts:91-110`
**Issue:** `readdir(dir)` returns ALL entries — files, directories, symlinks, dotfiles. The code constructs `join(dir, name, 'migration.ts')` for each, then calls `loadMigrationFile`. For non-directory entries (`.gitkeep`, `.DS_Store`, `README.md`), this produces an invalid path that `loadMigrationFile` (jiti) will fail on — currently swallowed by WR-01's `.catch(() => null)`.

Even if WR-01 is addressed, every non-directory entry will produce a noisy warning the user can't avoid. Filter to directories first.

**Fix:**
```typescript
import { readdir } from 'node:fs/promises';
// ...
const dirents = await readdir(dir, { withFileTypes: true });
const directories = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
// then iterate `directories` instead of raw entries
```

---

### WR-03: `clear-finalize.ts` uses substring match on error message to detect ConditionalCheckFailed

**File:** `src/state-mutations/clear-finalize.ts:43-47`
**Issue:** `if (msg.includes('ConditionalCheckFailed'))` is fragile. AWS SDK error messages can change format across SDK versions. The `cancellation.ts` module (per `state-mutations/index.ts:13`) exports `isConditionalCheckFailed` — the canonical helper for exactly this check. This file does not use it.

**Fix:**
```typescript
import { isConditionalCheckFailed } from './cancellation.js';
// ...
.catch((err: unknown) => {
  if (isConditionalCheckFailed(err)) {
    throw new EDBMigrationLockHeldError('clearFinalizeMode refused — lock no longer held by this runner or not in finalize state', {});
  }
  throw err;
});
```

`finalize-flow.ts:116-123` defines a duplicate `isConditionalCheckFailed` locally — also a code-smell. Same fix: import from `state-mutations/cancellation.js` (or wherever the canonical version lives) instead of redefining.

---

### WR-04: `create-migrations-client.ts` mutates undocumented smithy `middlewareStack` internal

**File:** `src/client/create-migrations-client.ts:88-100`
**Issue:** The `CloneableStack` type and the calls `(userDocClient.middlewareStack as unknown as CloneableStack).clone()` rely on a smithy-client implementation detail not exposed in the AWS SDK TypeScript types. The comment (lines 87-100) is admirably explicit about this, but the code will silently break the day smithy renames or removes `.clone()`.

Three risks:
1. AWS SDK v3 minor version bump removes `clone()` — runtime `TypeError` on `undefined is not a function`.
2. `clone()` returns a stack that is not a deep copy — the runner's middleware mutations leak into the user's stack.
3. The two `bundleDocClient` and `guardedDocClient` instances each wrap `userDocClient`, but their internal handler maps may share references; a guard middleware addition could still propagate.

This is the load-bearing isolation invariant for the runUnguarded bypass mechanism. A regression here means the runner gates itself again — the very bug T-04-11-03 was meant to prevent.

**Fix:** At minimum, add a runtime assertion + integration test that proves isolation. Consider replacing the clone strategy with a documented pattern:
- Construct two completely independent `DynamoDBClient` instances (one for the runner via `new DynamoDBClient(args.client.config)`, one for the guard via the user's original).
- Wrap only the guard instance.

That's the pattern hinted at in the comment block at lines 60-68 ("build the internal bundle from a FRESH `DynamoDBClient` constructed from the existing client's `config`") but the implementation took a different path. The fresh-client path is more robust to SDK changes.

---

### WR-05: `finalize` reuses `migrated` count slot for "deleted" — JSON history shape is misleading

**File:** `src/runner/finalize-flow.ts:72` and `src/cli/commands/finalize.ts:65`
**Issue:** Inside `finalizeFlow`, deletion successes are tallied via `audit.addMigrated(1)` (line 72) — labeled in JSDoc as "reused as deleted". The CLI command then prints `${f.itemCounts.migrated} deleted` (line 65). This works inside the CLI because the CLI knows it's finalize. But:

1. `history --json` for finalized migrations shows `itemCounts.migrated` containing what is actually a delete count. Operators querying `jq '.[] | select(.status == "finalized") | .itemCounts.migrated'` will reasonably interpret it as "records migrated" in the apply sense — silently wrong.
2. The README §4.10 documents `scanned/migrated/skipped/failed` semantics from the apply path. There is no documented "in finalize, `migrated` means `deleted`" contract.

This is a stable JSON contract violation. Either rename the field, add a separate `deleted` slot to `ItemCounts`, or document the overload prominently.

**Fix:** Add a separate `deleted` counter to `ItemCounts` and use `audit.addDeleted(1)` in `finalizeFlow`. OR: keep the dual-use but stamp the row's `kind` or `phase` so consumers can tell apply-counts from finalize-counts.

---

### WR-06: `apply.ts` and client both write success messages — duplicate output

**File:** `src/cli/commands/apply.ts:73` (paired with `src/client/create-migrations-client.ts:158-175`)
**Issue:** When `apply` succeeds with N>=1 migrations:

1. The programmatic client writes the full multi-line summary to `process.stderr` (line 173-174 of `create-migrations-client.ts`) — including "Applied N migrations in T", per-migration counts, and "Next steps:" checklist.
2. The CLI's spinner immediately calls `spinner.success(c.ok('Applied N migration(s).'))` (line 73 of `apply.ts`), writing a one-line confirmation also to stderr.

Operators see the one-liner appearing AFTER the multi-line summary, which is awkward. More problematically, the spinner's transient line during the apply may overwrite portions of the client's summary if the rendering library uses cursor manipulation.

Decide on one source of truth for the summary. Options:
- Move the summary-render call out of the client into the CLI (cleanest separation; the client returns data, the UI renders it).
- Have the CLI suppress its own success line when the client emits a summary.

**Fix:** Prefer moving rendering to the CLI. The client returns `{applied, summary}`, and only `apply.ts` writes to stderr. The programmatic API's claim that it emits the "Next steps" checklist regardless of CLI vs programmatic is fine in principle; suppress the spinner's redundant success line:

```typescript
if (result.applied.length === 0) {
  spinner.stop();
  log.info('No migrations to apply.');
  return;
}
spinner.stop(); // do NOT emit a redundant success line; client already wrote summary
```

---

### WR-07: `runApply` / `runFinalize` / etc. construct fresh `DynamoDBClient` per command invocation; no client reuse

**File:** `src/cli/commands/apply.ts:40`, `src/cli/commands/finalize.ts:51`, `src/cli/commands/history.ts:35`, `src/cli/commands/release.ts:33`, `src/cli/commands/status.ts:38`
**Issue:** Every command builds its own `new DynamoDBClient(...)`. For one-shot CLI invocations this is fine. But this same code path runs from the programmatic API (e.g., a long-running test harness or Lambda environment that calls `runApply` repeatedly). Each call creates a fresh client with fresh credential resolution and a new HTTP/2 connection — non-trivial latency cost.

More importantly, the action handler does not `await` cleanup of the SDK client. AWS SDK v3 clients have `destroy()` for explicit cleanup; not calling it leaks sockets in long-running processes.

**Fix:** For v0.1 CLI use this is a documentation issue at most. But surface it: the programmatic API contract should be that `createMigrationsClient` accepts a user-supplied client and the user manages its lifecycle. The `runApply`-style helpers are CLI-internal; consider not exposing them as a programmatic surface.

---

### WR-08: `release()` throws plain `Error` (untyped) when `lockRunId` is missing

**File:** `src/client/create-migrations-client.ts:259-261`
**Issue:** `if (!row.lockRunId) { throw new Error('release refused — release-mode lock missing lockRunId (corrupted state).'); }`

This is the only error path in `release` that does not set a `code` or `remediation`. The CLI handler (`release.ts:60`) reads `(err as { remediation?: string }).remediation` — for this throw, remediation is undefined, so the operator gets a bare error message with no recovery hint. Other error paths in the same function (line 252-257) set both.

**Fix:**
```typescript
if (!row.lockRunId) {
  const err: Error & { code?: string; remediation?: string } = new Error(
    'release refused — release-mode lock row exists but lockRunId is missing (corrupted state).',
  );
  err.code = 'EDB_LOCK_CORRUPT';
  err.remediation = 'Inspect with `electrodb-migrations status`. If lock state is unrecoverable, use `electrodb-migrations unlock --force`.';
  throw err;
}
```

---

### WR-09: `iterateV1Records` scan does not pass `consistent: true`

**File:** `src/runner/scan-pipeline.ts:42`
**Issue:** The v1 record scan uses `entity.scan.go({ cursor, limit })` with no `consistent` option. DynamoDB's default scan is eventually consistent. While the lock-state machine (lock acquired in `apply`) prevents concurrent app writes that would matter, app traffic IS still allowed for reads (per blockMode) and any in-flight write that hadn't committed at scan time may not be visible.

This is the data-loss adjacent risk: a record that exists and is not yet visible to an eventually-consistent scan would be skipped from migration. After the migration finalizes (deletes v1), the late-visible record is dropped.

CLAUDE.md project context explicitly calls out: "All guard `GetItem` calls MUST use `ConsistentRead: true`". The same logic should apply to the runner's scan since the migration's correctness depends on seeing every v1 record.

**Fix:** Pass `consistent: true` to the scan options. Note: DynamoDB does NOT support strongly-consistent scans on global secondary indexes — the primary `byId` index used by the migrations entities is the table's primary key, so this is fine. Verify the user's entity also indexes on the primary key.

```typescript
const page = await v1.scan.go({ cursor, limit, consistent: true });
```

---

### WR-10: `history-format.ts` and `create-migrations-client.ts` duplicate the Set→sorted-array conversion logic

**File:** `src/runner/history-format.ts:67-71`, `src/client/create-migrations-client.ts:271-275`, `src/client/create-migrations-client.ts:286-290`
**Issue:** Three different code blocks perform the same `reads === undefined ? undefined : [...reads].sort()` transformation. The `history()` and `status()` methods of the client open-code this; `formatHistoryJson` does it once. If the canonical mapping changes (e.g. add `failedIds` Set conversion), the duplication will silently skip some sites.

**Fix:** Extract a single normalization helper in `runner/history-format.ts`:

```typescript
export function normalizeHistoryRow(r: RawHistoryRow): HistoryRow {
  const { reads, ...rest } = r;
  const readsArr = reads === undefined ? undefined : [...reads].sort();
  return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) } as HistoryRow;
}
```

Then `history()` and `status()` import and use `normalizeHistoryRow`.

---

### WR-11: `apply-flow.ts` post-error patch swallows errors silently

**File:** `src/runner/apply-flow.ts:70-76`
**Issue:** After `markFailed`, the code patches `_migrations.status='failed'` with `.catch(() => {})` (line 74). The comment says "Non-fatal: the lock row's failedIds is the authoritative failure surface." This is reasonable, but the swallow loses ALL information — including AWS SDK errors that signal credential expiry, rate limit, or a deeper DDB outage. The operator may then debug the lock-row failure without realizing the audit row is also broken.

**Fix:** At minimum log to stderr, like the `markFailed` catch handler at lines 60-63 does:

```typescript
.catch((patchErr: unknown) => {
  // eslint-disable-next-line no-console -- diagnostic only; CR-04 disposition
  console.error('[electrodb-migrations] applyFlow: post-error _migrations patch rejected:', patchErr);
  // Non-fatal: lock row's failedIds is authoritative.
});
```

---

_Reviewed: 2026-05-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
