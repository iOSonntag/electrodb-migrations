# Future Ideas

A parking lot for design changes that are deliberately **not** in scope for the current
release. Each item is captured with enough context that a future maintainer can
pick it up without rediscovering the why.

---

## Per-entity guard scoping

**Current behaviour.** The guard wrapper is table-wide: when a migration is in
flight (or `failedIds` / `deploymentBlockedIds` is non-empty), every wrapped
DDB call against the table is blocked. `blockMode: 'writes-only'` softens this
by letting reads through, but a runtime block still affects entities the
migration didn't touch.

**Idea.** Track the entity scope of in-flight / failed / blocked migrations and
let the guard ask "is *this specific entity* affected?" before blocking.

Sketch:
- The aggregate `_migration_state` row already records `lockMigrationId` while
  a runner is active and the migrations themselves know their `entityName`.
  Extend the aggregate so each id-list is keyed by entity:
  `inFlightByEntity: { User: ['mig-1'] }`, etc.
- The guard middleware reads `commandName` and the inbound command's
  `TableName` already; for ElectroDB-shaped writes/reads it could *also* infer
  the entity from the partition key prefix (the `__edb_e__` field on items, or
  the leading `pk` segment for indexed ops).
- `blockMode: 'all'` becomes `blockMode: 'all' | 'writes-only' | 'per-entity'`.

**Why not now.**
- Inferring the entity from a raw command is fragile: GSI queries, batch ops,
  and PartiQL all hide the entity from the immediate request shape.
- The "this is safe across entities" claim only holds if the user's app is
  multi-version-aware on every code path. Most aren't.
- Table-wide blocking with `blockMode: 'writes-only'` covers the common case
  (read-heavy app + small DDB-load migration window).

**Trigger to revisit.** A user reports that table-wide blocking is too coarse
for their workload — specifically, a real "we have hundreds of entities and one
migration's bake window stalls all writes" story.

---

## Per-migration parallelism

**Current behaviour.** The runner mutex is global. `apply([m1, m2, m3])` runs
sequentially: m1 acquires the mutex, runs, releases; then m2; then m3. No two
runners can be active at the same time, even if the migrations touch unrelated
entities.

**Idea.** Allow multiple runners to be active concurrently when their
migrations don't conflict.

Sketch:
- The aggregate `_migration_state` row's `inFlightIds` is a set; today its
  cardinality is 0 or 1 because of the global mutex. Extend the model to
  permit cardinality > 1 by acquiring a *per-migration* mutex inside the
  aggregate row instead of a single global one.
- Bootstrap once; per-acquire conditional update sets `lockRefId` keyed by
  migrationId (e.g., `locks: map<migrationId, { refId, holder, ... }>`).
- Conflict policy: refuse to acquire if any in-flight migration shares an
  entity (or touches the same partition-key set) as the requested one.
- Stale-lock takeover becomes per-migration too.

**Why not now.**
- The global mutex is correct, simple, and matches operator mental models
  ("only one migration runs at a time").
- The conflict-detection layer is hard: two migrations on the same entity
  *can* be safe (different fields) or unsafe (overlapping shape changes).
  Encoding that policy needs care.
- The state row's conditional-update story gets significantly harder under
  per-migration locks (multiple writers contending for the same item).
- A single table-wide TransactWriteItems still works because it's keyed by
  migrationId, but the consistency story for the aggregate becomes one of
  the items in the transaction *and* a where-clause keyed by sub-attribute,
  which ElectroDB's `where` callback handles awkwardly for map sub-attributes.

**Trigger to revisit.** A user has a multi-entity migration suite where the
sequential bottleneck is dominant — e.g., 10 migrations × 30 minutes each
each touching unrelated entities, where the operator wants 6 hours in 30
minutes via parallel apply.

---

## DDB-Streams push invalidation of the guard cache

**Current behaviour.** The guard cache is TTL-only (default 1s). After a
runner releases its lock, wrapped clients can be stale for up to `cacheTtlMs`.

**Idea.** Subscribe to the table's DDB Stream for `_migration_state` row
updates and call `cache.invalidate()` on each event. Drops the staleness
window to roughly the stream-propagation delay (~1s on average, but
predictably in-band).

**Why not now.**
- DDB Streams require explicit table configuration the user controls; we
  can't enable them on their behalf.
- The TTL approach is good enough: the runner's `acquireWaitMs` (default 10s)
  exceeds the cache TTL by 10×, so a fresh acquire is invisible to readers
  by the time it commits.

---

## CLI: `--force` re-apply for `reverted` migrations

**Current behaviour.** `decideApply` returns `requires-rollback` for
`reverted` migrations. There is no path to re-apply a reverted migration
short of editing the `_migrations` row by hand.

**Idea.** A `--force` flag on `electrodb-migrations apply` that resets a
reverted row to `pending` and proceeds. Operator-confirmed, audit-logged.

**Why not now.**
- `reverted` is intentionally terminal. The CLI is still scaffold; surfacing
  this in the Node API first would set a precedent before the operator UX is
  designed.

---

## Operator audit log for `forceUnlock` / `releaseAllDeploymentBlocks`

**Current behaviour.** Both methods are unconditional escape hatches with no
record of who invoked them.

**Idea.** Append a row to a separate `_migration_audit` entity with
`{ at, action, invokedBy, prevState }` on every escape-hatch call.

**Why not now.**
- v0.1 scope is correctness, not auditing. Operators with a compliance need
  can wrap the methods themselves.
