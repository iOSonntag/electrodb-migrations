# Phase 7: Validate, Regenerate & Acknowledge-Removal — Research

**Researched:** 2026-05-09
**Domain:** CI validation gate — pure file-system rules engine; no DDB I/O
**Confidence:** HIGH

---

## Summary

Phase 7 delivers the last line of defense before `apply`: `validate` runs eight deterministic rules against the file system and produces a full problem list (not short-circuit) before exiting non-zero. The command is pure FS + entity-import — no DDB calls, no lock, sub-second on a clean repo. Two companion operations complete the phase: `create --regenerate <id>` rewrites frozen snapshots for a migration that has been rebased onto a newer baseline, and `acknowledge-removal <EntityName>` writes a tombstone marker that satisfies the removed-entities rule.

All data sources already exist. `loadEntityFile` / `discoverEntityFiles` / `extractEntityMetadata` from Phase 2's `src/user-entities/` handle entity loading. `readEntitySnapshot` / `readJournal` from Phase 1's `src/snapshot/` handle snapshot reads. `loadMigrationFile` (jiti-based) from Phase 4's `src/runner/` loads migration modules from disk. The drift classifier (`src/drift/classify.ts`) and fingerprint projection (`src/safety/fingerprint-projection.ts`) from Phases 1-2 provide the sub-primitives needed by rules VAL-01 and VAL-08.

The integrity-hash infrastructure is already in place: `computeIntegrityHash` in `src/scaffold/integrity-hash.ts` and the `frozenSnapshots` array in `EntitySnapshotFile`. Phase 7 only has to read them, not invent a new storage location.

**Primary recommendation:** Build a `src/validate/` module containing a rule-registry interface and eight standalone rule implementations. The registry pattern allows `--skip-rule` / `--only-rule` to be added in a future phase without touching rule logic. Every rule receives a pre-loaded `ValidateContext` struct (entity metas, snapshots, migration files) assembled once by the validate orchestrator, avoiding redundant jiti calls.

---

## Phase Requirements

<phase_requirements>

| ID | Description | Research Support |
|----|-------------|-----------------|
| VAL-01 | Drift without migration: entity current shape ≠ latest snapshot AND no scaffolded migration covers the diff | `fingerprintEntityModel` + `classifyDrift` on snapshot vs live entity; `discoverMigrationFolders` to check coverage |
| VAL-02 | Version-skew: entity `model.version` must equal latest scaffolded `toVersion` | `EntityMetadata.modelVersion` from `extractEntityMetadata`; compare to highest `toVersion` in migration list for that entity |
| VAL-03 | Sequence-gaps: migrations per entity must run 1, 2, 3, … (or starting at `migrationStartVersions[entity]`) | Sort by `fromVersion` numeric; check for gaps; respect `config.migrationStartVersions` |
| VAL-04 | Parallel-branch-collision: two migrations claiming same `fromVersion` for same entity | Group by `(entityName, fromVersion)`; if any group has count > 1, fail with both ids |
| VAL-05 | Cross-entity ordering: every `reads` target has no later-sequenced pending migration | Load `migration.reads` from each migration file; compare sequence positions |
| VAL-06 | Removed-entities: entity that previously existed (in journal) now absent from FS, unless tombstone present | Compare journal entries to discovered entities; check for `.removed` tombstone |
| VAL-07 | Reserved-namespace: user entity names cannot start with `_` | Simple string prefix check on `EntityMetadata.entityName` |
| VAL-08 | Frozen snapshot integrity: `v1.ts` / `v2.ts` SHA-256 must match scaffold-time hash in `frozenSnapshots` | `computeIntegrityHash(readFileSync(v1Path))` vs `snapshot.frozenSnapshots[i].v1Sha256` |
| VAL-09 | Non-zero exit on any failure, zero on clean | Collect all findings first, then `process.exit` |
| VAL-10 | `acknowledge-removal <entity>` advances snapshot to record entity as intentionally removed | Write tombstone; subsequent validate exits zero |
| SCF-08 | `create --regenerate <id>` rewrites `v1.ts`/`v2.ts`, preserves `up()`/`down()`, advances from/to versions, updates hash | Load current entity + previous snapshot; re-emit frozen sources; re-hash; update `frozenSnapshots` |
| CLI-02 | `--remote` ignored on file-only commands | validate, regenerate, acknowledge-removal never accept `--remote`; plumb the gate in the command handlers |

</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Rule engine (8 rules) | CLI / FS layer | — | Pure FS reads; no DDB tier involved |
| Entity discovery + loading | CLI / FS layer | `src/user-entities/` | Phase 2 already owns this |
| Snapshot reads | CLI / FS layer | `src/snapshot/` | Phase 1 already owns this |
| Migration folder discovery | CLI / FS layer | `src/runner/load-migration-module.ts` | jiti-based loader already exists |
| Integrity-hash verification (VAL-08) | CLI / FS layer | `src/scaffold/integrity-hash.ts` | `computeIntegrityHash` already ships |
| Regenerate (SCF-08) | CLI / FS layer | `src/scaffold/` | Extends scaffold orchestrator |
| Tombstone write (VAL-10) | CLI / FS layer | `src/snapshot/` | Extend snapshot paths |
| Output / exit codes | CLI output tier | `src/cli/output/` | Follows Phase 2 patterns |

---

## Standard Stack

### Core (already in project — no new deps needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `jiti` | `^2.6.0` | Load `migration.ts` + `v1.ts` / `v2.ts` at validate time | Already ships; `loadMigrationFile` uses it |
| `picocolors` | `^1.1.0` | Terminal coloring for validate output | Already ships; `c.*` helpers in `src/cli/output/colors.ts` |
| `cli-table3` | `^0.6.5` | Tabular findings output | Already ships; `createTable` in `src/cli/output/table.ts` |
| `commander` | `^12.0.0` | CLI command registration | Already ships; follows `registerXCommand` pattern |
| `node:crypto` | built-in | Re-compute `sha256:` hash for VAL-08 | `computeIntegrityHash` in `src/scaffold/integrity-hash.ts` already uses it |
| `node:fs` | built-in | Read `v1.ts` / `v2.ts` bytes for re-hashing | Standard FS read |

No new runtime dependencies are needed for Phase 7. All the required primitives already exist.

### Alternatives Considered

| Standard | Alternative | Tradeoff |
|----------|-----------|----------|
| Per-call `createJiti(…, {tryNative:false, fsCache:false, moduleCache:false})` for entity loading | Shared jiti instance | Per-call pattern is already proven correct in `loadEntityFile` — avoids stale-module Pitfall 4 |
| Single-pass validate context (load everything once, then run all rules) | Load per-rule | Single-pass is measurably faster and avoids redundant jiti invocations hitting the 1-second SC-1 budget |

---

## Architecture Patterns

### System Architecture Diagram

```
CLI Entry: `validate`
    │
    ▼
resolveCliConfig (global --config flag)
    │
    ▼
buildValidateContext(cwd, config)
    ├─► discoverEntityFiles()         → entity file list
    │       └─► loadEntityFile(f)     → live entity metadata
    │               └─► extractEntityMetadata()
    │
    ├─► readJournal(_journal.json)    → known entity list
    │
    ├─► readEntitySnapshot(per entity) → fingerprints + frozenSnapshots
    │
    ├─► discoverMigrationFolders(migrationsDir) → folder list
    │       └─► loadMigrationFile(path)  [jiti] → Migration objects
    │               └─► reads fromVersion, toVersion, entityName, reads[]
    │
    └─► ValidateContext assembled
            │
            ▼
    runAllRules(ctx) → ValidationFinding[]
            │
    ┌───────┼──────────────────────────────────┐
    ▼       ▼                                  ▼
  VAL-01   VAL-02 ... VAL-08          (collect ALL findings)
    │
    ▼
  printFindings(findings)  →  cli-table3 table to stdout
    │
    ▼
  process.exit(findings.length > 0 ? 1 : 0)   [VAL-09]
```

### Recommended Project Structure

```
src/
├── validate/
│   ├── types.ts          # ValidateContext, ValidationFinding, ValidateRule interface
│   ├── context.ts        # buildValidateContext() — loads all data sources once
│   ├── run-rules.ts      # runAllRules(ctx) — iterates registry
│   ├── rules/
│   │   ├── drift-without-migration.ts   # VAL-01
│   │   ├── version-skew.ts              # VAL-02
│   │   ├── sequence-gaps.ts             # VAL-03
│   │   ├── parallel-branch-collision.ts # VAL-04
│   │   ├── cross-entity-ordering.ts     # VAL-05
│   │   ├── removed-entities.ts          # VAL-06
│   │   ├── reserved-namespace.ts        # VAL-07
│   │   └── frozen-snapshot-edited.ts    # VAL-08
│   └── index.ts          # re-exports
├── cli/
│   └── commands/
│       ├── validate.ts          # registerValidateCommand + runValidate
│       └── acknowledge-removal.ts # registerAcknowledgeRemovalCommand
│   (create.ts extended for --regenerate <id>)
```

### Pattern 1: ValidateRule Interface

**What:** A consistent shape for all 8 rules, enabling registry-based invocation and future `--skip-rule` / `--only-rule` flags.

**When to use:** Every rule in `src/validate/rules/` implements this interface.

```typescript
// src/validate/types.ts
export interface ValidationFinding {
  rule: string;               // stable slug, e.g. 'drift-without-migration'
  severity: 'error';          // v0.1: all findings are errors
  entityName?: string;        // which entity triggered the finding
  migrationId?: string;       // which migration triggered the finding
  message: string;            // human-readable description
  fix: string;                // CLI command or action to resolve
  detail?: Record<string, unknown>; // optional extra context for --json
}

export interface ValidateRule {
  name: string;               // matches the finding rule slug
  check(ctx: ValidateContext): ValidationFinding[];
}
```

**Registry:**
```typescript
// src/validate/run-rules.ts
export function runAllRules(ctx: ValidateContext): ValidationFinding[] {
  const rules: ValidateRule[] = [
    reservedNamespaceRule,     // fast; no IO — run first
    driftWithoutMigrationRule,
    versionSkewRule,
    sequenceGapsRule,
    parallelBranchCollisionRule,
    crossEntityOrderingRule,
    removedEntitiesRule,
    frozenSnapshotEditedRule,
  ];
  return rules.flatMap(r => r.check(ctx));
}
```

### Pattern 2: ValidateContext (single-pass load)

**What:** Pre-load all data sources before running rules. Avoids redundant jiti invocations.

```typescript
// src/validate/types.ts  (continued)
export interface MigrationRecord {
  id: string;
  entityName: string;
  fromVersion: string;          // numeric decimal string
  toVersion: string;
  reads: readonly string[];     // entity names from migration.reads
  folderPath: string;           // absolute path to migration folder
}

export interface ValidateContext {
  cwd: string;
  config: ResolvedConfig;
  /** Live entities currently on disk, keyed by entityName */
  liveEntities: Map<string, EntityMetadata>;
  /** Entity names previously recorded in _journal.json (including removed ones) */
  journaledEntityNames: ReadonlySet<string>;
  /** Per-entity snapshot file, keyed by entityName */
  snapshots: Map<string, EntitySnapshotFile>;
  /** All migration records loaded from disk, sorted (entityName ASC, fromVersion ASC) */
  migrations: ReadonlyArray<MigrationRecord>;
  /** Set of entity names with a tombstone file (.electrodb-migrations/removed/<Entity>.tombstone) */
  acknowledgedRemovals: ReadonlySet<string>;
}
```

### Pattern 3: Rule Implementations

**VAL-01 — drift-without-migration:**
```typescript
// Data: ctx.liveEntities, ctx.snapshots, ctx.migrations
// Logic:
//   For each liveEntity:
//     currentFingerprint = fingerprintEntityModel(entity.model).fingerprint
//     snapshotFingerprint = ctx.snapshots.get(entityName)?.fingerprint
//     if snapshotFingerprint !== 'sha256:' + currentFingerprint:
//       check if migrations contains a pending migration with fromVersion >= snapshotVersion
//       if no covering migration found → emit finding
// Fix: "run `electrodb-migrations create --entity <name> --name <slug>`"
```

**VAL-02 — version-skew:**
```typescript
// Data: ctx.liveEntities, ctx.migrations
// Logic:
//   For each entityName in liveEntities:
//     maxToVersion = max(migrations.filter(m => m.entityName === name).map(m => Number(m.toVersion)))
//     if maxToVersion !== Number(meta.modelVersion) → emit finding
//     (entities with no migrations: toVersion implicitly = current modelVersion, no skew possible)
// Fix: "update model.version to '<toVersion>' in your entity source"
```

**VAL-03 — sequence-gaps:**
```typescript
// Data: ctx.migrations, ctx.config.migrationStartVersions
// Logic:
//   For each entityName:
//     startVersion = config.migrationStartVersions[entityName]?.version ?? 1
//     sorted = migrations.filter(entityName).sortBy(fromVersion)
//     expected = startVersion
//     for each m in sorted:
//       if Number(m.fromVersion) !== expected → gap found (missing version expected)
//       expected = Number(m.toVersion)
// Fix: "create the missing migration for v<expected>→v<missing>"
```

**VAL-04 — parallel-branch-collision:**
```typescript
// Data: ctx.migrations
// Logic:
//   Map: (entityName, fromVersion) → MigrationRecord[]
//   For each group with length > 1 → emit finding with both ids
// Fix: "rebase the later branch and run `create --regenerate <id>`"
```

**VAL-05 — cross-entity ordering:**
```typescript
// Data: ctx.migrations (reads field per migration)
// Logic:
//   For each migration M with reads.length > 0:
//     For each readTarget in M.reads:
//       Later pending migrations on readTarget =
//         migrations.filter(n => n.entityName === readTarget && Number(n.fromVersion) >= Number(M.toVersion))
//       if any found → emit finding naming M.id and the blocking migration id
// Fix: "apply <readTarget migration> first OR reorder migrations"
// Note: reads on disk = from migration.reads[] (NOT from _migrations DDB rows — pure FS)
```

**VAL-06 — removed-entities:**
```typescript
// Data: ctx.journaledEntityNames, ctx.liveEntities, ctx.acknowledgedRemovals
// Logic:
//   For each entityName in journaledEntityNames:
//     if not in liveEntities AND not in acknowledgedRemovals → emit finding
// Fix: "run `electrodb-migrations acknowledge-removal <EntityName>`"
```

**VAL-07 — reserved-namespace:**
```typescript
// Data: ctx.liveEntities
// Logic:
//   For each entityName in liveEntities:
//     if entityName.startsWith('_') → emit finding
// Fix: "rename the entity to a name that does not start with '_'"
```

**VAL-08 — frozen-snapshot-edited:**
```typescript
// Data: ctx.snapshots, migration folder paths (cwd + config.migrations + migrationId)
// Logic:
//   For each entityName, snapshot:
//     For each frozenSnapshots entry { migrationId, v1Sha256, v2Sha256 }:
//       migFolderPath = join(migrationsDir, migrationId)
//       v1Actual = computeIntegrityHash(readFileSync(join(migFolderPath, 'v1.ts')))
//       v2Actual = computeIntegrityHash(readFileSync(join(migFolderPath, 'v2.ts')))
//       if v1Actual !== v1Sha256 OR v2Actual !== v2Sha256 → emit finding
// Fix: "run `create --regenerate <id>` to regenerate the frozen files"
```

### Pattern 4: acknowledge-removal tombstone

The tombstone is a zero-byte file at a deterministic path inside `.electrodb-migrations/`:

```
.electrodb-migrations/removed/<EntityName>.tombstone
```

`snapshotPaths` needs a helper `entityRemovedTombstonePath(rootDir, entityName)` analogous to `entitySnapshotPath`. The `acknowledge-removal` command:

1. Validates `entityName` is not a live entity (would be nonsensical to tombstone a present entity).
2. Validates `entityName` exists in the journal (tombstoning an unknown entity is likely a typo).
3. Writes the zero-byte tombstone file.
4. Prints "Entity '<X>' recorded as intentionally removed. Subsequent `validate` will exit zero for this entity."

The tombstone directory is always inside `.electrodb-migrations/` so it is committed alongside the snapshots — no external database needed.

### Pattern 5: create --regenerate

The regenerate flow in `scaffold/create.ts` (or a parallel `scaffold/regenerate.ts`):

1. Load the existing migration from disk via `loadMigrationFile` — extract `entityName`, `fromVersion`, `toVersion`, `id`.
2. Read the current live entity (via `discoverEntityFiles` + `loadEntityFile` + `extractEntityMetadata`).
3. Compute the "new v1" = the snapshot at the PREVIOUS entity version. This is the current journal's snapshot BEFORE the migration's `fromVersion`. Concretely: read `readEntitySnapshot` for the entity; this snapshot now reflects what A's branch made the entity. That IS the new v1 baseline after rebase.
   - If the entity has only one migration chain on main, the previous shape is: read the `frozenSnapshots` entry in the current snapshot for the migration BEFORE this one, or if this is the first migration, use `null` (greenfield).
   - **Simpler and correct:** the new v1 source is re-derived from `fingerprintEntityModel` on the CURRENT `from` entity inside the migration module. After rebase, main's entity file has been updated by branch A's `create` to bump `model.version`. The migration module's `from` (v1.ts) now has STALE content — but the SNAPSHOT file now has the correct "previous shape" (because baseline or A's `create --regenerate` updated it). So the new v1 source = `renderFrozenEntitySource(currentEntitySnapshot.projection, new fromVersion)` and the new v2 source = `renderFrozenEntitySource(liveEntityProjection, new toVersion)`.
4. Compute new `fromVersion` = current entity snapshot's implied version (= previous toVersion on main), new `toVersion` = fromVersion + 1.
5. Re-render `v1.ts` and `v2.ts` via `renderFrozenEntitySource`.
6. Compute new hashes via `computeIntegrityHash`.
7. Overwrite `v1.ts` and `v2.ts` in the migration folder. Do NOT touch `migration.ts` (preserves user's `up()`/`down()` byte-for-byte).
8. Update the `frozenSnapshots` entry for this migration in the entity snapshot file.
9. Print the new schema diff via `renderSchemaDiff`.

Key invariant: `migration.ts` is NEVER touched by `--regenerate`. The user's `up()`/`down()` logic stays intact. Only the two frozen schema files (v1/v2) and the stored hashes are updated.

### Anti-Patterns to Avoid

- **Short-circuiting after first rule failure:** SC-2 requires "eight rule violations each surface as distinct, readable error messages". Never `return` early from `runAllRules`. Collect all findings.
- **Using `appliedAt` timestamps for cross-entity ordering (VAL-05):** Clock-skew between developer machines makes timestamps unreliable. Use `fromVersion` numeric comparison — the same pattern as `findBlockingReadsDependency` in Phase 6.
- **Touching `migration.ts` in `--regenerate`:** The user's `up()`/`down()` code is the labor-intensive part. The only contract is that `v1.ts`/`v2.ts` are replaced.
- **Re-using a cached jiti instance across entity loads:** `loadEntityFile` uses `{fsCache: false, moduleCache: false}`. Validate must do the same — the user may have edited entity files between CLI invocations in the same shell session. See Pitfall 1 below.
- **Separate DDB calls from validate:** The phase success criterion 1 requires "no DDB calls". Do not check `_migrations` rows for VAL-03/04/05. All three rules operate on migration FOLDERS on disk only.

---

## Open Question Resolutions

### OQ1 — Validate rule registry shape

**Recommendation: use the `ValidateRule` interface** (Pattern 1 above). Each rule is an object with `name: string` and `check(ctx): ValidationFinding[]`. The registry is a plain array in `run-rules.ts`. This allows `--skip-rule` and `--only-rule` by filtering the array before iteration — no rule internals change. This is directly analogous to Phase 5's truth-table dispatch in `checkPreconditions`.

### OQ2 — VAL-08 frozen-snapshot integrity hash storage

**Confirmed existing location:** `EntitySnapshotFile.frozenSnapshots` (an array of `{migrationId, v1Sha256, v2Sha256}`) in `.electrodb-migrations/snapshots/<Entity>.snapshot.json`.

This is already implemented. Phase 2's `scaffold/create.ts` (step 9/13) writes `v1Sha256` and `v2Sha256` after calling `computeIntegrityHash`. Phase 2's `scaffold/integrity-hash.ts` defines `computeIntegrityHash`. Phase 1's `src/snapshot/types.ts` already declares `frozenSnapshots?: ReadonlyArray<{migrationId, v1Sha256, v2Sha256}>`. [VERIFIED: codebase read]

Phase 7 adds the READ path only: for each `frozenSnapshots` entry, read the actual file on disk, re-hash it, compare. No new storage location needed.

### OQ3 — `create --regenerate` semantics

**Confirmed:** `up()`/`down()` live in `migration.ts`. `v1.ts` and `v2.ts` are generated by `renderFrozenEntitySource` (frozen schema only — no user logic). The regenerate command must:
- Read current snapshot (projection representing the new baseline's v1 shape).
- Read current live entity projection (new v2 shape).
- Derive new fromVersion / toVersion.
- Re-emit `v1.ts` and `v2.ts` via `renderFrozenEntitySource`.
- Update the `frozenSnapshots` entry in the snapshot file.
- NEVER touch `migration.ts`. [VERIFIED: codebase read of `scaffold/frozen-snapshot.ts` and `scaffold/create.ts`]

### OQ4 — `acknowledge-removal` data model

**Recommendation: tombstone marker file** at `.electrodb-migrations/removed/<Entity>.tombstone`.

Rationale:
- Simplest durable shape VAL-06 can read: `existsSync(tombstonePath)`.
- Committed in `.electrodb-migrations/` alongside snapshots — diffs cleanly in PRs.
- No new JSON parsing needed.
- Naturally idempotent (writing a zero-byte file twice is harmless).
- The `removed/` subdirectory parallels `snapshots/` and is immediately understandable.

Alternative rejected: writing a "removed" marker into the snapshot file itself (e.g. `fingerprint: 'removed'`). That approach creates reader ambiguity — `readEntitySnapshot` would need special-case logic for the `'removed'` fingerprint value, polluting the type.

Add `entityRemovedTombstonePath(rootDir, entityName)` to `src/snapshot/paths.ts`.

### OQ5 — VAL-03 + `migrationStartVersions`

**Confirmed:** `migrationStartVersions` is already typed in `ResolvedConfig` as `Record<string, { version: number }>` (from `src/config/types.ts`). The validate rule must read `config.migrationStartVersions[entityName]?.version ?? 1` as the starting `expected` version before walking the sorted migration list. [VERIFIED: codebase read]

### OQ6 — VAL-05 cross-entity ordering source of truth

**Confirmed:** VAL-05 is pure FS. It reads `migration.reads` from the migration module objects already loaded into `ValidateContext.migrations`. The `reads` field is `ReadonlyArray<AnyElectroEntity>` on the `Migration` type — but for validate purposes we only need the entity names, which come from `m.reads.map(e => (e as {model:{entity:string}}).model.entity)`. This is a pure disk read: jiti loads the migration module, the `reads` array is the live ElectroDB entity instances declared by the user. No DDB. No `_migrations` rows consulted. [VERIFIED: REQUIREMENTS.md VAL-05 + Phase 6 CTX-07 + codebase read of `src/migrations/types.ts`]

### OQ7 — `validate` performance budget

**Analysis:** SC-1 requires sub-1-second on a clean repo. The bottlenecks are:
1. jiti calls per entity file (fsCache/moduleCache disabled). Budget ~50-100ms per entity file; a typical project has 5-20 entity files → 250-2000ms RISK.
2. jiti calls per migration file. Budget ~30-50ms per migration; a project with 20 migrations → 600-1000ms RISK.

**Recommendation:** For the validate use case, entity loading can use a LESS strict jiti config than `loadEntityFile` because validate is a read-only CI gate — stale-module correctness in an edit-save-rerun cycle is less critical than during interactive `create`. Using `{tryNative: true, fsCache: true, moduleCache: false}` for entity loads in validate would benefit from jiti's filesystem cache while still avoiding stale Node ESM cache. But to be safe, reuse the proven `{tryNative: false, fsCache: false, moduleCache: false}` for the first iteration and measure. If SC-1 is breached in practice, the optimization is to enable `fsCache: true` on the validate path only. Document the tradeoff and surface as a config option in v0.2 if needed.

**Migration file loads in validate:** Only `migration.ts` is needed (jiti transitively loads `v1.ts`/`v2.ts`). One jiti call per migration folder. Performance is bounded by folder count.

**Recommendation for Wave 0:** Add a performance smoke test that measures `validate` on a 20-entity / 40-migration fixture. Gate on < 2 seconds (give headroom vs the 1-second SC), fail the test if it regresses.

### OQ8 — `validate` JSON output for CI

**Recommendation: YES, ship `--json` on validate.** The README does not currently document it, but Phase 4 set the precedent with `history --json`. CI scripts that want to grep for specific failure rules need machine-readable output. The `ValidationFinding` struct already has all the necessary fields. The README §4.12 section should be updated to document `--json`.

Implementation: add `--json` option to `registerValidateCommand`. In the action handler, if `--json` is set, `process.stdout.write(JSON.stringify(findings, null, 2) + '\n')` instead of the table. Exit code is still controlled by `findings.length > 0`.

### OQ9 — Phase 7 + Phase 8 boundary

**Confirmed: no overlap.** `testMigration` in Phase 8 imports `v1.ts`/`v2.ts` directly as ElectroDB entities; it does not read integrity hashes or `frozenSnapshots`. The test harness trusts the imported module shapes; validate's job is to catch tampered files before they reach apply. These are orthogonal concerns. [ASSUMED based on Phase 8 description in ROADMAP.md — Phase 8 has not been planned yet]

### OQ10 — VAL-10 content

**Confirmed from REQUIREMENTS.md line 168:**
> VAL-10: `acknowledge-removal <entity>` advances the snapshot to record the entity as intentionally removed; does NOT touch records on disk.

VAL-10 is the `acknowledge-removal` sub-command itself, not a validate rule. The requirement defines the command behavior: write a durable marker, no DDB. The command satisfies VAL-06 for subsequent runs by writing the tombstone that VAL-06 checks.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TS/ESM module loading | Custom eval/import pipeline | `loadMigrationFile` (jiti) already in `src/runner/` | Already handles ESM, CJS, TS, caching nuances |
| SHA-256 hash of file bytes | Custom hash function | `computeIntegrityHash` in `src/scaffold/integrity-hash.ts` | Already deployed and tested; takes `string | Buffer` |
| Entity fingerprint | Rebuild projection logic | `fingerprintEntityModel` in `src/safety/fingerprint-projection.ts` | Phase 1 primitive; already tested against ElectroDB 3.0/3.5/3.7 |
| Drift classification | Custom attribute diffing | `classifyDrift` in `src/drift/classify.ts` | Phase 2 primitive; all 8 drift kinds covered |
| Frozen source generation (regenerate) | Custom TS emitter | `renderFrozenEntitySource` in `src/scaffold/frozen-snapshot.ts` | Phase 2 primitive; deterministic, alphabetically sorted output |
| Snapshot reads/writes | Custom JSON parser | `readEntitySnapshot` / `writeEntitySnapshot` in `src/snapshot/` | Phase 1; handles schemaVersion gating and sorted-key output |
| Entity discovery | Custom FS walk | `discoverEntityFiles` in `src/user-entities/discover.ts` | Phase 2; handles EXCLUDED_DIRS, dedup, sort |
| Terminal output | Raw `process.stdout.write` | `log.*` + `createTable` + `c.*` from `src/cli/output/` | Phase 2 established output conventions; exit-code discipline |

---

## Common Pitfalls

### Pitfall 1: Stale jiti module cache in validate

**What goes wrong:** If validate reuses a jiti instance across entity and migration file loads, an entity file edited between the `create` scaffold and the subsequent `validate` run may be loaded from jiti's module cache — reporting a stale fingerprint and missing the drift.

**Why it happens:** jiti's `moduleCache` integrates with Node's `require.cache`. Without `moduleCache: false`, a file loaded once stays in cache for the process lifetime.

**How to avoid:** Use per-call `createJiti(import.meta.url, {tryNative: false, fsCache: false, moduleCache: false})` for entity loading in validate. This is the pattern already used by `loadEntityFile` in `src/user-entities/load.ts`. Migration files loaded in validate can use `{tryNative: true}` (the pattern used by `loadMigrationFile` in `src/runner/load-migration-module.ts`) since they are not edited between runs in CI contexts.

**Warning signs:** VAL-01 reports no drift even after editing an entity; or validate exits zero on a branch that should fail.

### Pitfall 2: VAL-05 using DDB `_migrations.reads` instead of on-disk migration files

**What goes wrong:** VAL-05 is defined as a pure FS rule (no DDB). If the implementation accidentally consults `_migrations` rows, it breaks SC-1 (no DDB calls) and introduces a dependency on the DDB being accessible in CI.

**Why it happens:** Phase 6's `findBlockingReadsDependency` (in `src/rollback/preconditions.ts`) consults `_migrations.reads` — a natural template for VAL-05. But that function operates at APPLY time on already-persisted rows. VAL-05 operates on PENDING migrations that may never have been applied.

**How to avoid:** VAL-05 reads `migration.reads` from the Migration object loaded by jiti — the `reads` field on the `defineMigration({...})` call in each migration folder. It does NOT query DDB.

**Warning signs:** VAL-05 passes in isolation but fails in CI (where DDB is unavailable); or VAL-05 silently passes for brand-new migrations that have never been applied.

### Pitfall 3: VAL-03/04 counting gaps with clock-based migration IDs

**What goes wrong:** Migration IDs contain a timestamp prefix (`20260501083000-User-add-status`). A naive sort by migration ID (string sort) would order migrations alphabetically by timestamp, which IS correct for single-entity sequences — but if the user accidentally uses the same timestamp on two migrations (clock collision), neither rule would report the problem accurately.

**Why it happens:** Temptation to sort by folder name instead of by `fromVersion` numeric value.

**How to avoid:** Sort by `Number(fromVersion)` for VAL-03 gap detection. For VAL-04 collision detection, group by `(entityName, fromVersion)` — not by timestamp. Two migrations claiming the same `fromVersion` for the same entity is the collision definition, regardless of their IDs.

**Warning signs:** VAL-04 fails to detect a collision when two migration folders have timestamps 1 second apart; VAL-03 reports gaps incorrectly on entities starting at version > 1.

### Pitfall 4: `migrationStartVersions` ignored in VAL-03

**What goes wrong:** A project that uses `migrationStartVersions: { User: { version: 5 } }` (because User was at v5 when they adopted the framework) will fail VAL-03 if the rule hardcodes `expected = 1`. The rule would flag "missing v1→v2, v2→v3, v3→v4, v4→v5" for an entity that was deliberately started at v5.

**Why it happens:** `migrationStartVersions` is documented in CFG-09 and `ResolvedConfig.migrationStartVersions` but is easy to overlook in rule implementations.

**How to avoid:** `ValidateContext` must include `config: ResolvedConfig` (or at least `config.migrationStartVersions`). VAL-03's implementation reads `config.migrationStartVersions[entityName]?.version ?? 1` as the initial `expected` value.

**Warning signs:** Projects with `migrationStartVersions` in their config get false-positive sequence-gap failures.

### Pitfall 5: `--regenerate` leaving a stale `frozenSnapshots` entry

**What goes wrong:** `--regenerate <id>` rewrites `v1.ts`/`v2.ts` and must update the corresponding `frozenSnapshots` entry in the entity's snapshot file. If the update finds the entry by array index instead of by `migrationId`, concurrent regenerations or out-of-order writes could corrupt the hash array.

**Why it happens:** `frozenSnapshots` is an array (not a map) — lookup must be by `migrationId` string, not by position.

**How to avoid:** In the regenerate orchestrator, find the existing `frozenSnapshots` entry by `migrationId`, replace it in-place, and write the snapshot back. If the entry does not exist (the migration was scaffolded before Phase 7 shipped `frozenSnapshots`), push a new entry.

**Warning signs:** After `--regenerate`, `validate` still reports `frozen-snapshot-edited` for the regenerated migration.

### Pitfall 6: VAL-06 false-positive when entity is renamed (not removed)

**What goes wrong:** A user renames `User` to `UserProfile` in their entity file. VAL-06 sees `User` in the journal but not in the live entities and fires — but the real situation is a rename, not a removal.

**Why it happens:** The framework has no rename primitive in v0.1.

**How to avoid:** The error message for VAL-06 should say "Entity 'User' was previously snapshotted but is no longer found. If this is a removal, run `acknowledge-removal User`. If this is a rename, run `baseline` after updating the entity name." This is documentation-only, not code logic.

### Pitfall 7: `reads` entity names from migration module require model inspection

**What goes wrong:** The `Migration.reads` field is typed as `ReadonlyArray<AnyElectroEntity>` — actual ElectroDB entity instances, not strings. VAL-05 needs the entity name strings.

**Why it happens:** The `reads` declaration is `reads: [Team, Org]` in source — live entity instances. The name must be extracted via `(entity as {model:{entity:string}}).model.entity`.

**How to avoid:** In `buildValidateContext`, when loading migration records, extract entity names from `migration.reads` using the same model introspection used elsewhere in the codebase. Store as `reads: readonly string[]` in `MigrationRecord` — rule implementations never need the entity instances.

---

## Runtime State Inventory

This is a greenfield feature addition, not a rename/refactor. No runtime state needs migrating.

The only file-system additions Phase 7 makes to the committed `.electrodb-migrations/` directory are:
- Zero-byte tombstone files at `.electrodb-migrations/removed/<EntityName>.tombstone` (written by `acknowledge-removal`).
- Updated `frozenSnapshots` entries in existing snapshot files (written by `create --regenerate`).

Both are additive and backward-compatible with existing snapshot readers.

---

## Integration Seams

The following existing functions are consumed by Phase 7 with no modification required:

| Function | Location | Consumed By |
|----------|----------|------------|
| `discoverEntityFiles` | `src/user-entities/discover.ts` | `buildValidateContext` — discovers entity files |
| `loadEntityFile` | `src/user-entities/load.ts` | `buildValidateContext` — loads each entity via jiti |
| `extractEntityMetadata` | `src/user-entities/inspect.ts` | `buildValidateContext` — extracts name/version/model |
| `fingerprintEntityModel` | `src/safety/fingerprint-projection.ts` | VAL-01 — computes live fingerprint |
| `classifyDrift` | `src/drift/classify.ts` | VAL-01 — determines whether drift is "covered" |
| `readJournal` | `src/snapshot/read.ts` | `buildValidateContext` — loads journaled entity list |
| `readEntitySnapshot` | `src/snapshot/read.ts` | `buildValidateContext` + VAL-08 — loads stored fingerprints and frozenSnapshots |
| `writeEntitySnapshot` | `src/snapshot/write.ts` | `create --regenerate` — updates frozenSnapshots entry |
| `entitySnapshotPath` | `src/snapshot/paths.ts` | `buildValidateContext` — resolves per-entity snapshot path |
| `snapshotPaths` | `src/snapshot/paths.ts` | `buildValidateContext` — resolves `.electrodb-migrations/` root |
| `loadMigrationFile` | `src/runner/load-migration-module.ts` | `buildValidateContext` — loads each migration.ts via jiti |
| `computeIntegrityHash` | `src/scaffold/integrity-hash.ts` | VAL-08 — re-hashes v1.ts/v2.ts |
| `renderFrozenEntitySource` | `src/scaffold/frozen-snapshot.ts` | `create --regenerate` — re-emits v1.ts/v2.ts |
| `renderSchemaDiff` | `src/drift/diff.ts` | `create --regenerate` — prints new schema diff |
| `buildProgram` / `BuildProgramOpts` | `src/cli/program.ts` | Add `registerValidate`, `registerAcknowledgeRemoval` slots |
| `log.*`, `c.*`, `createTable` | `src/cli/output/` | validate output formatting |
| `EXIT_CODES` | `src/cli/output/exit-codes.ts` | Exit 1 on findings; exit 0 on clean |
| `resolveCliConfig` | `src/cli/shared/resolve-config.ts` | Load config in all new command handlers |

**New additions to existing files:**
1. `src/snapshot/paths.ts`: Add `entityRemovedTombstonePath(rootDir, entityName)` and `removedDir` path.
2. `src/cli/program.ts`: Add `registerValidate` and `registerAcknowledgeRemoval` to `BuildProgramOpts`.
3. `src/cli/index.ts`: Lazy-import and register the two new commands.
4. `src/cli/commands/create.ts`: Add `--regenerate <id>` option alongside `--entity` and `--name`.

---

## Environment Availability

Step 2.6: SKIPPED — Phase 7 is purely file-system + jiti (already installed). No external services, databases, or CLI tools beyond the existing project dependencies.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.x |
| Config file | `vitest.config.ts` (existing) |
| Quick run command | `pnpm test --reporter=dot tests/unit/validate/` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VAL-01 | drift-without-migration rule fires on shape drift with no covering migration | unit | `pnpm test tests/unit/validate/rules/drift-without-migration.test.ts` | Wave 0 |
| VAL-02 | version-skew rule fires when `model.version` ≠ latest `toVersion` | unit | `pnpm test tests/unit/validate/rules/version-skew.test.ts` | Wave 0 |
| VAL-03 | sequence-gaps rule fires on version gap; respects `migrationStartVersions` | unit | `pnpm test tests/unit/validate/rules/sequence-gaps.test.ts` | Wave 0 |
| VAL-04 | parallel-branch-collision rule fires when two migrations claim same fromVersion | unit | `pnpm test tests/unit/validate/rules/parallel-branch-collision.test.ts` | Wave 0 |
| VAL-05 | cross-entity-ordering rule fires on out-of-order `reads` dependency (no DDB) | unit | `pnpm test tests/unit/validate/rules/cross-entity-ordering.test.ts` | Wave 0 |
| VAL-06 | removed-entities rule fires without tombstone; passes with tombstone | unit | `pnpm test tests/unit/validate/rules/removed-entities.test.ts` | Wave 0 |
| VAL-07 | reserved-namespace rule fires on `_`-prefixed entity name | unit | `pnpm test tests/unit/validate/rules/reserved-namespace.test.ts` | Wave 0 |
| VAL-08 | frozen-snapshot-edited rule fires on hash mismatch | unit | `pnpm test tests/unit/validate/rules/frozen-snapshot-edited.test.ts` | Wave 0 |
| VAL-09 | validate exits non-zero on any finding; zero on clean repo | unit | `pnpm test tests/unit/validate/exit-code.test.ts` | Wave 0 |
| VAL-10 | acknowledge-removal writes tombstone; subsequent validate exits zero | unit + integration | `pnpm test tests/unit/validate/acknowledge-removal.test.ts` | Wave 0 |
| SCF-08 | `--regenerate` rewrites v1/v2, preserves migration.ts, updates hash | unit | `pnpm test tests/unit/scaffold/regenerate.test.ts` | Wave 0 |
| CLI-02 | validate, regenerate, acknowledge-removal ignore `--remote` | unit (CLI flag) | `pnpm test tests/unit/cli/file-only-commands.test.ts` | Wave 0 |
| SC-1 | validate exits zero in < 1 second on clean 20-entity / 40-migration fixture | performance | `pnpm test tests/unit/validate/performance.test.ts` | Wave 0 |
| SC-2 | all 8 rule findings produce distinct, readable messages naming offending files | unit | covered by per-rule tests above | Wave 0 |
| SC-3 | `--regenerate` preserves up()/down() byte-for-byte | unit | `pnpm test tests/unit/scaffold/regenerate.test.ts` | Wave 0 |
| SC-4 | `acknowledge-removal` + subsequent validate on clean repo | unit | `pnpm test tests/unit/validate/acknowledge-removal.test.ts` | Wave 0 |
| SC-5 | frozen v1/v2 integrity hash checked at validate time | unit (VAL-08) | `pnpm test tests/unit/validate/rules/frozen-snapshot-edited.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `pnpm test tests/unit/validate/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

All test files listed above are new. Required Wave 0 scaffolding:

- [ ] `tests/unit/validate/` — new directory
- [ ] `tests/unit/validate/rules/drift-without-migration.test.ts`
- [ ] `tests/unit/validate/rules/version-skew.test.ts`
- [ ] `tests/unit/validate/rules/sequence-gaps.test.ts`
- [ ] `tests/unit/validate/rules/parallel-branch-collision.test.ts`
- [ ] `tests/unit/validate/rules/cross-entity-ordering.test.ts`
- [ ] `tests/unit/validate/rules/removed-entities.test.ts`
- [ ] `tests/unit/validate/rules/reserved-namespace.test.ts`
- [ ] `tests/unit/validate/rules/frozen-snapshot-edited.test.ts`
- [ ] `tests/unit/validate/exit-code.test.ts`
- [ ] `tests/unit/validate/acknowledge-removal.test.ts`
- [ ] `tests/unit/validate/performance.test.ts`
- [ ] `tests/unit/scaffold/regenerate.test.ts`
- [ ] `tests/unit/cli/file-only-commands.test.ts` (may already exist — verify)
- [ ] `tests/fixtures/validate/` — fixture entities, snapshots, and migration folders for each rule's happy and error paths

---

## Security Domain

Phase 7 introduces no authentication, network calls, or cryptographic operations beyond the existing SHA-256 re-hash (already used in Phase 2). No ASVS categories are newly applicable:

| ASVS Category | Applies | Rationale |
|---------------|---------|-----------|
| V2 Authentication | no | File-system read; no auth surface |
| V3 Session Management | no | No sessions |
| V4 Access Control | no | CLI running as the invoking user |
| V5 Input Validation | yes (minor) | `entityName` in `entitySnapshotPath` already validates against path-traversal; `acknowledge-removal`'s `<entity>` arg needs the same guard |
| V6 Cryptography | no | SHA-256 hash is pre-existing; no new crypto introduced |

**V5 action:** The `entityRemovedTombstonePath` helper must apply the same input validation as `entitySnapshotPath` (no `/`, `\`, or `..` in entity name). Copy the guard from `src/snapshot/paths.ts`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Phase 8's `testMigration` does not read `frozenSnapshots` or integrity hashes | OQ9 resolution | Low risk — Phase 8 ROADMAP description confirms it imports v1/v2 directly as entities |
| A2 | jiti 2.6.x on Node >=20 with `{fsCache:false, moduleCache:false}` for 20 entities + 40 migration files fits within a 2-second wall-clock budget in CI | OQ7 resolution | Medium risk — benchmark in Wave 0 performance test; if breached, enable `fsCache:true` on the validate path |
| A3 | The `reads` field on a loaded Migration object contains live ElectroDB entity instances (not plain strings), requiring `.model.entity` extraction | Pattern 3 VAL-05 | Low risk — confirmed by `src/migrations/types.ts` which declares `reads?: ReadonlyArray<AnyElectroEntity>` |

---

## Open Questions (RESOLVED)

1. **OQ-R1 — `--json` output format consensus.** The `ValidationFinding` struct proposed here has `rule`, `entityName`, `migrationId`, `message`, `fix`, `detail`. Should `fix` be a freeform string or a structured `{command, args}` shape? Recommendation: freeform string for v0.1 (mirrors CLI-09's remediation pattern); structured form is a v0.2 enhancement.

2. **OQ-R2 — `create --regenerate` when entity no longer exists.** If the user runs `--regenerate <id>` but the entity has been removed from the entities directory, the live entity cannot be loaded. The command should fail with a clear error: "Entity '<X>' not found in entities directory. Did you mean to run `acknowledge-removal <X>` instead?" This is a new error path not covered by the current `create` command's entity-not-found message.

---

## Sources

### Primary (HIGH confidence)
- `src/snapshot/types.ts` — confirms `frozenSnapshots` array shape already in `EntitySnapshotFile` [VERIFIED: codebase read]
- `src/scaffold/integrity-hash.ts` — confirms `computeIntegrityHash` already ships [VERIFIED: codebase read]
- `src/scaffold/create.ts` — confirms 12-step flow writing hashes at scaffold time [VERIFIED: codebase read]
- `src/snapshot/paths.ts` — confirms `entitySnapshotPath` pattern for path helpers [VERIFIED: codebase read]
- `src/user-entities/load.ts` — confirms `{fsCache: false, moduleCache: false}` pattern with detailed comment explaining the Pitfall 4 rationale [VERIFIED: codebase read]
- `src/runner/load-migration-module.ts` — confirms jiti migration loading pattern for migrate-discovery [VERIFIED: codebase read]
- `src/drift/classify.ts` — confirms `classifyDrift` and all 8 drift kinds [VERIFIED: codebase read]
- `src/config/types.ts` — confirms `migrationStartVersions: Record<string, {version:number}>` in `ResolvedConfig` [VERIFIED: codebase read]
- `src/errors/codes.ts` — confirms existing error code pattern; no `validate`-specific codes yet exist [VERIFIED: codebase read]
- `src/rollback/preconditions.ts` — confirms `findBlockingReadsDependency` pattern used for CTX-08; analogous to VAL-05 [VERIFIED: codebase read]
- `.planning/REQUIREMENTS.md` lines 159-169 — VAL-01..10 exact text [VERIFIED: file read]
- `.planning/ROADMAP.md` Phase 7 section — success criteria [VERIFIED: file read]
- `README.md` lines 624-634, 1012-1026 — `validate`, `acknowledge-removal`, `--regenerate` documented behavior [VERIFIED: file read]

### Secondary (MEDIUM confidence)
- `src/migrations/types.ts` — `Migration.reads` field type is `ReadonlyArray<AnyElectroEntity>`; entity names require `.model.entity` extraction [VERIFIED: codebase read]
- `src/cli/output/exit-codes.ts` — confirms `EXIT_CODES.USER_ERROR = 1` is the correct exit on validation failure [VERIFIED: codebase read]

---

## Metadata

**Confidence breakdown:**
- Integration seams: HIGH — all referenced functions confirmed in codebase
- Rule logic: HIGH — data sources confirmed; logic derived from requirement text and analogous existing code
- Storage location for tombstone: HIGH — pattern follows existing `entitySnapshotPath`
- Performance budget: MEDIUM — jiti timing under CI conditions not measured; Wave 0 performance test required
- `--regenerate` version arithmetic: MEDIUM — "new fromVersion = current snapshot's toVersion" needs a fixture test to confirm edge cases (first migration, entity with no prior migrations)

**Research date:** 2026-05-09
**Valid until:** 2026-06-09 (stable domain — ElectroDB peer dep pinned, all primitives already exist)
