# Phase 7: Validate, Regenerate & Acknowledge-Removal — Pattern Map

**Mapped:** 2026-05-09
**Files analyzed:** 27 new/modified files
**Analogs found:** 25 / 27

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/validate/types.ts` | model | transform | `src/migrations/types.ts` | exact |
| `src/validate/context.ts` | service | batch | `src/scaffold/create.ts` (Step 1–3 orchestration) | role-match |
| `src/validate/run-rules.ts` | service | batch | `src/rollback/preconditions.ts` (truth-table dispatch) | role-match |
| `src/validate/rules/drift-without-migration.ts` | utility | transform | `src/drift/classify.ts` | role-match |
| `src/validate/rules/version-skew.ts` | utility | transform | `src/drift/classify.ts` | role-match |
| `src/validate/rules/sequence-gaps.ts` | utility | transform | `src/drift/classify.ts` | role-match |
| `src/validate/rules/parallel-branch-collision.ts` | utility | transform | `src/drift/classify.ts` | role-match |
| `src/validate/rules/cross-entity-ordering.ts` | utility | transform | `src/rollback/preconditions.ts` (CTX-08 step) | role-match |
| `src/validate/rules/removed-entities.ts` | utility | transform | `src/drift/classify.ts` (entity-removed kind) | role-match |
| `src/validate/rules/reserved-namespace.ts` | utility | transform | `src/drift/classify.ts` | role-match |
| `src/validate/rules/frozen-snapshot-edited.ts` | utility | transform | `src/scaffold/integrity-hash.ts` | role-match |
| `src/validate/index.ts` | config | — | `src/snapshot/read.ts` (barrel pattern) | role-match |
| `src/scaffold/regenerate.ts` | service | transform | `src/scaffold/create.ts` | exact |
| `src/scaffold/acknowledge-removal.ts` | service | file-I/O | `src/snapshot/write.ts` | role-match |
| `src/cli/commands/validate.ts` | controller | request-response | `src/cli/commands/rollback.ts` | exact |
| `src/cli/commands/acknowledge-removal.ts` | controller | request-response | `src/cli/commands/rollback.ts` | exact |
| `src/snapshot/paths.ts` | utility | — | self | modified |
| `src/cli/program.ts` | config | — | self | modified |
| `src/cli/index.ts` | config | — | self | modified |
| `src/cli/commands/create.ts` | controller | request-response | self | modified |
| `tests/unit/validate/rules/*.test.ts` | test | transform | `tests/unit/snapshot/read.test.ts` | exact |
| `tests/unit/validate/exit-code.test.ts` | test | request-response | `tests/unit/cli/rollback.test.ts` | exact |
| `tests/unit/validate/acknowledge-removal.test.ts` | test | file-I/O | `tests/unit/scaffold/create.test.ts` | role-match |
| `tests/unit/validate/performance.test.ts` | test | batch | no analog | no-analog |
| `tests/unit/scaffold/regenerate.test.ts` | test | transform | `tests/unit/scaffold/create.test.ts` | exact |
| `tests/unit/cli/file-only-commands.test.ts` | test | request-response | `tests/unit/cli/rollback.test.ts` | role-match |
| `tests/fixtures/validate/` | config | — | `tests/_helpers/sample-migrations/` | role-match |

---

## Pattern Assignments

### `src/validate/types.ts` (model, transform)

**Analog:** `src/migrations/types.ts`

**File header pattern** (lines 1–16 of analog):
```typescript
import type { Entity } from 'electrodb';
// biome-ignore lint/suspicious/noExplicitAny: Required to reference ElectroDB's generic Entity
export type AnyElectroEntity = Entity<any, any, any, any>;
```

**Core type pattern** — define interfaces, union types, and const-maps in one file; no classes; all `interface` shapes have JSDoc explaining requirement IDs. Mirror the `Migration<From, To>` pattern with a discriminated-union return type:
```typescript
// src/validate/types.ts

export interface ValidationFinding {
  rule: string;           // stable slug, e.g. 'drift-without-migration'
  severity: 'error';      // v0.1: all findings are errors
  entityName?: string;
  migrationId?: string;
  message: string;
  fix: string;            // freeform remediation string (OQ-R1: structured form is v0.2)
  detail?: Record<string, unknown>;
}

export interface ValidateRule {
  name: string;           // matches the finding rule slug
  check(ctx: ValidateContext): ValidationFinding[];
}

export interface MigrationRecord {
  id: string;
  entityName: string;
  fromVersion: string;      // numeric decimal string — do NOT use for lexicographic comparison
  toVersion: string;
  reads: readonly string[]; // entity NAMES extracted from migration.reads[].model.entity
  folderPath: string;
}

export interface ValidateContext {
  cwd: string;
  config: ResolvedConfig;
  liveEntities: Map<string, EntityMetadata>;
  journaledEntityNames: ReadonlySet<string>;
  snapshots: Map<string, EntitySnapshotFile>;
  migrations: ReadonlyArray<MigrationRecord>;
  acknowledgedRemovals: ReadonlySet<string>;
}
```

**Import pattern** (follow `src/migrations/types.ts` and `src/snapshot/types.ts`):
```typescript
import type { ResolvedConfig } from '../config/types.js';
import type { EntityMetadata } from '../user-entities/index.js';
import type { EntitySnapshotFile } from '../snapshot/types.js';
```

**Conventions:**
- `.js` extension on ALL relative imports (even `.ts` source files) — project uses `"moduleResolution": "NodeNext"`.
- `ReadonlyArray<>` and `ReadonlySet<>` for all collections that rules must not mutate.
- No `export default`; all exports are named.

---

### `src/validate/context.ts` (service, batch)

**Analog:** `src/scaffold/create.ts` (orchestration pattern), `src/user-entities/load.ts` (jiti config)

**Imports pattern** (mirrors `src/scaffold/create.ts` lines 1–14):
```typescript
import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { discoverEntityFiles, loadEntityFile, extractEntityMetadata } from '../user-entities/index.js';
import { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
import { snapshotPaths, entitySnapshotPath } from '../snapshot/paths.js';
import { readJournal, readEntitySnapshot } from '../snapshot/read.js';
import { loadMigrationFile } from '../runner/load-migration-module.js';
import type { ResolvedConfig } from '../config/types.js';
import type { ValidateContext, MigrationRecord } from './types.js';
```

**Jiti config** — MUST use `{tryNative: false, fsCache: false, moduleCache: false}` for entity loading. Copy verbatim from `src/user-entities/load.ts` lines 54–58:
```typescript
// From src/user-entities/load.ts lines 54-58 (verbatim for entity loads)
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  fsCache: false,
  moduleCache: false,
});
```

For migration file loading, reuse `loadMigrationFile` from `src/runner/load-migration-module.ts` (it already uses `{tryNative: true}` which is correct for CI-static migration files).

**Migration discovery pattern** — migration folders live at `join(migrationsDir, folderName)`. Discover by `readdirSync` filtering for directory entries, then call `loadMigrationFile(join(folder, 'migration.ts'))`. Extract `reads` entity names via `.model.entity` inspection on each reads entry (Pitfall 7 in RESEARCH).

**Reads entity-name extraction** (Pitfall 7):
```typescript
// migration.reads is ReadonlyArray<AnyElectroEntity> — extract names
const reads: string[] = (migration.reads ?? []).map(
  (e) => (e as { model: { entity: string } }).model.entity,
);
```

**Tombstone discovery** — reads the `removed/` subdirectory inside `.electrodb-migrations/`:
```typescript
// entityRemovedTombstonePath not yet in paths.ts — this is one of Phase 7's additions
const removedDir = join(snapshotPaths(cwd).root, 'removed');
const acknowledgedRemovals = new Set<string>();
if (existsSync(removedDir)) {
  for (const f of readdirSync(removedDir)) {
    if (f.endsWith('.tombstone')) acknowledgedRemovals.add(f.slice(0, -'.tombstone'.length));
  }
}
```

**Error handling pattern** — wrap jiti failures in `EDBMigrationLoadError` or `EDBUserEntityLoadError` (already defined in `src/runner/load-migration-module.ts` and `src/user-entities/load.ts`). Let `EDBSnapshotMalformedError` from `readEntitySnapshot` propagate uncaught — the CLI surface handles it.

---

### `src/validate/run-rules.ts` (service, batch)

**Analog:** `src/rollback/preconditions.ts` (truth-table dispatch pattern)

**Core pattern** (mirrors Phase 5's `checkPreconditions` flat dispatch):
```typescript
// src/validate/run-rules.ts

import type { ValidateContext, ValidationFinding, ValidateRule } from './types.js';
import { reservedNamespaceRule }     from './rules/reserved-namespace.js';
import { driftWithoutMigrationRule } from './rules/drift-without-migration.js';
import { versionSkewRule }           from './rules/version-skew.js';
import { sequenceGapsRule }          from './rules/sequence-gaps.js';
import { parallelBranchCollisionRule } from './rules/parallel-branch-collision.js';
import { crossEntityOrderingRule }   from './rules/cross-entity-ordering.js';
import { removedEntitiesRule }       from './rules/removed-entities.js';
import { frozenSnapshotEditedRule }  from './rules/frozen-snapshot-edited.js';

const RULES: readonly ValidateRule[] = [
  reservedNamespaceRule,     // fast, no I/O — run first
  driftWithoutMigrationRule,
  versionSkewRule,
  sequenceGapsRule,
  parallelBranchCollisionRule,
  crossEntityOrderingRule,
  removedEntitiesRule,
  frozenSnapshotEditedRule,
];

/**
 * Run all rules over the pre-loaded context. NEVER returns early — all
 * findings are collected before returning (SC-2 requires 8 distinct messages).
 * VAL-09.
 */
export function runAllRules(ctx: ValidateContext): ValidationFinding[] {
  return RULES.flatMap((r) => r.check(ctx));
}
```

**Anti-pattern guard** — never `return` early from `runAllRules`. The `flatMap` pattern naturally collects all findings. Mirrors the Phase 5 philosophy: collect all error conditions, then decide what to do.

---

### `src/validate/rules/*.ts` — Eight rule files (utility, transform)

**Analog:** `src/drift/classify.ts` (pure-function, deterministic, JSDoc with requirement ID)

**File structure pattern** (copy from `src/drift/classify.ts` lines 1–20):
```typescript
/**
 * VAL-0X — <rule-name>: <one-sentence description>. Pure function;
 * no I/O. Operates on the pre-loaded ValidateContext.
 *
 * Logic: <what the rule checks>
 * Fix: "run `electrodb-migrations <command>`"
 */
import type { ValidateContext, ValidationFinding } from '../types.js';

export const <ruleName>Rule = {
  name: '<rule-slug>',
  check(ctx: ValidateContext): ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    // ... logic ...
    return findings;
  },
} satisfies import('../types.js').ValidateRule;
```

**Key rule-specific notes:**

- **drift-without-migration (VAL-01):** Call `fingerprintEntityModel(entity.model)` from `src/safety/fingerprint-projection.ts` to get the live fingerprint. Compare against `ctx.snapshots.get(entityName)?.fingerprint`. A covering migration exists when `ctx.migrations` has an entry for that entity with `fromVersion === snapshot.version`. Do NOT call `classifyDrift` in this rule — the fingerprint comparison is sufficient and avoids double-computation.

- **sequence-gaps (VAL-03):** Respect `ctx.config.migrationStartVersions[entityName]?.version ?? 1` as `expected` seed. Sort by `Number(m.fromVersion)` (not by migration ID string). Pitfall 3 and 4 in RESEARCH.

- **parallel-branch-collision (VAL-04):** Group by `(entityName, fromVersion)` using a `Map<string, MigrationRecord[]>` keyed by `${entityName}::${fromVersion}`. Flag any group with `length > 1`. Never sort by migration ID.

- **cross-entity-ordering (VAL-05):** `ctx.migrations` already has `reads: readonly string[]` (entity names, pre-extracted in `buildValidateContext`). No DDB calls. Compare `Number(m.fromVersion)` for ordering. Pitfall 2 in RESEARCH — do NOT touch `_migrations` rows.

- **frozen-snapshot-edited (VAL-08):** Use `computeIntegrityHash(readFileSync(path))` from `src/scaffold/integrity-hash.ts`. The `frozenSnapshots` array is on `ctx.snapshots.get(entityName)?.frozenSnapshots`. Find the entry by `migrationId` (not array index — Pitfall 5 in RESEARCH). Resolve frozen file paths via `join(config.migrations, migrationId, 'v1.ts')` using the same `isAbsolute` resolution used in `scaffold/create.ts` Step 7.

**`biome-ignore` pattern** — when a rule needs a non-null assertion on a guaranteed-in-bounds array access, copy the standard pattern from `src/cli/commands/create.ts` lines 58–59:
```typescript
// biome-ignore lint/style/noNonNullAssertion: array bounds guaranteed by loop condition
curr[j] = ...curr[j - 1]!...
```

---

### `src/scaffold/regenerate.ts` (service, transform)

**Analog:** `src/scaffold/create.ts` (exact — same 12-step flow, subset of steps)

**Imports pattern** (copy from `src/scaffold/create.ts` lines 1–14, remove ts-morph-related items):
```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
import { entitySnapshotPath } from '../snapshot/paths.js';
import { readEntitySnapshot } from '../snapshot/read.js';
import { writeEntitySnapshot } from '../snapshot/write.js';
import { renderFrozenEntitySource } from './frozen-snapshot.js';
import { computeIntegrityHash } from './integrity-hash.js';
import { loadMigrationFile } from '../runner/load-migration-module.js';
import type { EntitySnapshotFile } from '../snapshot/types.js';
```

**Error class pattern** (copy `EDBDriftNotDetectedError` from `src/scaffold/create.ts` lines 43–45, create `EDBRegenerateError`):
```typescript
export class EDBRegenerateError extends EDBMigrationError {
  readonly code = 'EDB_REGENERATE_ERROR' as const;
}
```

**Core orchestration** — mirrors `scaffold/create.ts` but:
1. Read the existing migration via `loadMigrationFile(join(migFolderPath, 'migration.ts'))` to extract `id`, `entityName`, `fromVersion`, `toVersion`.
2. Read the entity's current snapshot (`readEntitySnapshot`); this IS the new v1 shape (the baseline on main after rebase).
3. Read the live entity via `loadEntityFile` + `extractEntityMetadata` to get the new v2 projection.
4. Re-emit `v1.ts` via `renderFrozenEntitySource({projection: snapshotProjection, version: newFromVersion})`.
5. Re-emit `v2.ts` via `renderFrozenEntitySource({projection: liveProjection, version: newToVersion})`.
6. Recompute hashes via `computeIntegrityHash`.
7. Overwrite `v1.ts` and `v2.ts` on disk — **NEVER touch `migration.ts`** (SC-3).
8. Update `frozenSnapshots` entry by `migrationId` — find by `entry.migrationId === migrationId`, replace in-place (Pitfall 5). If not found, push a new entry.
9. Write snapshot via `writeEntitySnapshot`.

**OQ-R2 guard** — if the live entity cannot be loaded (entity removed), throw `EDBRegenerateError` with message: `"Entity '<X>' not found in entities directory. Did you mean to run \`acknowledge-removal <X>\` instead?"`.

---

### `src/scaffold/acknowledge-removal.ts` (service, file-I/O)

**Analog:** `src/snapshot/write.ts` (mkdirSync + writeFileSync pattern)

**Imports pattern** (copy from `src/snapshot/write.ts` lines 1–4):
```typescript
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotPaths } from '../snapshot/paths.js';
import { readJournal } from '../snapshot/read.js';
import { entityRemovedTombstonePath } from '../snapshot/paths.js';
```

**Core pattern** — three validation steps, then a single `writeFileSync` of zero bytes:
```typescript
// 1. entityName must not be empty / path-traversal (reuse entitySnapshotPath's guard — copy it)
// 2. entityName must NOT be in liveEntities (tombstoning a present entity is nonsensical)
// 3. entityName MUST be in the journal (tombstoning an unknown entity is likely a typo — VAL-06 would never fire)
// 4. Write zero-byte tombstone
mkdirSync(join(snapshotPaths(cwd).root, 'removed'), { recursive: true });
writeFileSync(entityRemovedTombstonePath(cwd, entityName), '', 'utf8');
```

Idempotent: if tombstone already exists, overwrite with empty string — harmless and avoids an unnecessary `existsSync` check.

---

### `src/cli/commands/validate.ts` (controller, request-response)

**Analog:** `src/cli/commands/rollback.ts` (closest match — same pattern: file-only, no DDB client, no spinner needed for sub-1s command)

**Imports pattern** (copy from `src/cli/commands/rollback.ts` lines 1–8, REMOVE the DDB client imports since validate is file-only):
```typescript
import type { Command } from 'commander';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createTable } from '../output/table.js';
import { resolveCliConfig } from '../shared/resolve-config.js';
// validate-specific:
import { buildValidateContext } from '../../validate/context.js';
import { runAllRules } from '../../validate/run-rules.js';
```

**RunArgs interface** — file-only commands do NOT have a DDB client; no `region`, no `remote`:
```typescript
export interface RunValidateArgs {
  cwd: string;
  configFlag?: string;
  json?: boolean;   // OQ8: --json mode for CI script consumption
}
```

**CLI-02 pattern** — `validate` does not accept `--remote`. The `program.opts()` read for the global `--config` flag is the ONLY global option consumed. Do not read `--remote` or `--region`. This is the "file-only" gate from CLI-02. Contrast with `rollback.ts` which creates a `DynamoDBClient`.

**Output pattern** — on findings, use `createTable` (from `src/cli/output/table.ts`) for human output, or `JSON.stringify` for `--json`. Exit code is controlled by `process.exit(findings.length > 0 ? EXIT_CODES.USER_ERROR : EXIT_CODES.OK)` (VAL-09). ALL output goes to `process.stderr` (matches `log.*` convention in `src/cli/output/log.ts`).

**Action handler pattern** (copy from `src/cli/commands/rollback.ts` lines 92–117 exactly, adapting for validate):
```typescript
export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Run eight file-system rules; exits non-zero on any failure (VAL-01..09)')
    .option('--json', 'Output findings as JSON (for CI consumption)', false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runValidate({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          json: opts.json ?? false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
```

---

### `src/cli/commands/acknowledge-removal.ts` (controller, request-response)

**Analog:** `src/cli/commands/rollback.ts` (positional argument + file-only)

**Pattern:** Same as `validate.ts` above — no DDB client, no spinner. Single positional `<entity>` argument (mirrors `rollback <id>`). After calling `runAcknowledgeRemoval`, print `log.ok(...)` with the exact message from RESEARCH Pattern 4.

**Commander positional argument pattern** (copy from `src/cli/commands/rollback.ts` line 87):
```typescript
program
  .command('acknowledge-removal <entity>')
  .description('Record an entity as intentionally removed; subsequent validate exits zero (VAL-10)')
  .action(async (entity: string, _opts: unknown) => { ... });
```

---

### Modified: `src/snapshot/paths.ts`

**Analog:** `src/snapshot/paths.ts` itself (additive change — new helper following existing pattern)

**New function to add** (copy the validation guard from `entitySnapshotPath` lines 44–53 verbatim, adapting only the path suffix and error message):
```typescript
// New constants (add after existing SNAPSHOTS_SUBDIR_NAME):
export const REMOVED_SUBDIR_NAME = 'removed' as const;

/**
 * Resolves the absolute path of the tombstone file written by
 * `acknowledge-removal <entity>`. Applies the same path-traversal guard
 * as `entitySnapshotPath` — entity names must not contain `/`, `\`, or `..`.
 * V5 input validation (Research §Security Domain).
 */
export function entityRemovedTombstonePath(rootDir: string, entityName: string): string {
  if (entityName.length === 0) {
    throw new Error('entityRemovedTombstonePath: entity name must be non-empty');
  }
  if (entityName.includes('/') || entityName.includes('\\') || entityName.includes('..')) {
    throw new Error(
      `entityRemovedTombstonePath: invalid entity name "${entityName}" — must not contain path separators or '..'`,
    );
  }
  const { root } = snapshotPaths(rootDir);
  return join(root, REMOVED_SUBDIR_NAME, `${entityName}.tombstone`);
}
```

---

### Modified: `src/cli/program.ts`

**Analog:** `src/cli/program.ts` itself

**Changes:** Add three new optional slots to `BuildProgramOpts` and call them in `buildProgram`. Follow the existing `registerRollback?: (program: Command) => void` pattern exactly:
```typescript
// Add to BuildProgramOpts:
registerValidate?: (program: Command) => void;
registerAcknowledgeRemoval?: (program: Command) => void;
// NOTE: --regenerate is an option on the existing `create` command, NOT a new top-level command.
// See "create --regenerate decision" section below.

// Add to buildProgram body (after registerUnlock?.(program)):
opts.registerValidate?.(program);
opts.registerAcknowledgeRemoval?.(program);
```

---

### Modified: `src/cli/index.ts`

**Analog:** `src/cli/index.ts` itself

**Changes:** Add two more `tryImportRegistrar` calls to the existing `Promise.all` array. Follow the pattern exactly — one entry per new command file:
```typescript
tryImportRegistrar('./commands/validate.js', 'registerValidateCommand'),
tryImportRegistrar('./commands/acknowledge-removal.js', 'registerAcknowledgeRemovalCommand'),
```

Spread the results into `buildProgram(...)` with `registerValidate` and `registerAcknowledgeRemoval` keys. Keep the existing `Promise.all` shape — add to the END to avoid renumbering destructuring positions.

---

### Modified: `src/cli/commands/create.ts`

**Analog:** `src/cli/commands/create.ts` itself

**Changes:** Add `--regenerate <id>` option to the existing `create` command in `registerCreateCommand`. The `RunCreateArgs` interface gains an optional `regenerate?: string` field. When `regenerate` is present:
1. Dynamically import `../../scaffold/regenerate.js` (same FND-06 lazy-chain discipline as the existing `import('../../scaffold/create.js')`).
2. Call `scaffoldRegenerate({...})` and print `log.ok(...)` for each updated file.
3. When `regenerate` is set, `--entity` and `--name` are NOT required — override commander's `.requiredOption` by checking `process.argv` in the action or by making both options non-required and validating at runtime.

**Why extend `create.ts` rather than a new file:** Prevents barrel-ownership conflicts. The `registerCreateCommand` function already owns the `create` subcommand slot in `program.ts` and `index.ts`. A separate `registerRegenerateCommand` would either need its own commander subcommand (deviating from README's `create --regenerate` syntax) or would conflict with the `create` slot. Extending `create.ts` directly keeps the commander wiring in one place and avoids the Phase 5 barrel-conflict lesson (where two plans touching the same barrel caused merge conflicts).

---

## Shared Patterns

### Pattern A: No DDB Client on File-Only Commands

**Source:** `src/cli/commands/rollback.ts` lines 47–49 (creates DynamoDBClient) vs `src/cli/commands/create.ts` (no DDB client at all)
**Apply to:** `validate.ts`, `acknowledge-removal.ts`
**Rule (CLI-02):** File-only commands NEVER import or instantiate `DynamoDBClient`. The `finally { ddb.destroy() }` pattern from `rollback.ts` does NOT appear in file-only command files.

The absence of the DDB client is itself load-bearing — if `validate.ts` accidentally pulls in `DynamoDBClient`, the SC-1 "no DDB calls" criterion fails at the import level.

### Pattern B: `resolveCliConfig` as the First Call

**Source:** `src/cli/shared/resolve-config.ts` — used in EVERY command handler
**Apply to:** All three new command files
```typescript
// Always the first substantive line of runXxx():
const { config, cwd } = await resolveCliConfig({
  cwd: args.cwd,
  ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
});
```

### Pattern C: Error Discrimination by `.code` (not `instanceof`)

**Source:** `src/cli/commands/create.ts` lines 163–183
**Apply to:** `validate.ts`, `acknowledge-removal.ts`, `regenerate` extension in `create.ts`
```typescript
// Copy verbatim from create.ts:
const code = (err as { code?: string }).code;
if (code === 'EDB_SOME_ERROR') {
  const message = err instanceof Error ? err.message : String(err);
  log.err(message, 'remediation hint here');
  process.exit(EXIT_CODES.USER_ERROR);
}
throw err; // re-throw unknown errors — action handler formats via log.err
```

### Pattern D: Action Handler try/catch Shell

**Source:** `src/cli/commands/rollback.ts` lines 92–117 and `src/cli/commands/unlock.ts` lines 186–202
**Apply to:** All new `registerXxxCommand` functions
```typescript
.action(async (opts) => {
  try {
    const configFlag = program.opts<{ config?: string }>().config;
    await runXxx({ cwd: process.cwd(), ...(configFlag !== undefined ? { configFlag } : {}), ...opts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const remediation = (err as { remediation?: string }).remediation;
    log.err(message, remediation);
    process.exit(EXIT_CODES.USER_ERROR);
  }
});
```

### Pattern E: `readFileSync` / `writeFileSync` with `mkdirSync` Guard

**Source:** `src/snapshot/write.ts` lines 33–34
**Apply to:** `src/scaffold/acknowledge-removal.ts` (tombstone writer), `src/scaffold/regenerate.ts` (v1/v2 overwrite)
```typescript
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, stringifyForSnapshot(payload), 'utf8');
```
For tombstones, the content is `''` (zero bytes). For regenerate, the content is the rendered source string.

### Pattern F: `frozenSnapshots` Array Mutation by `migrationId` (not index)

**Source:** `src/scaffold/create.ts` lines 193–197 (write path); `src/snapshot/types.ts` lines 34–39 (shape)
**Apply to:** `src/scaffold/regenerate.ts`

Find-and-replace pattern:
```typescript
const prev = snapshot.frozenSnapshots ?? [];
const existing = prev.findIndex((e) => e.migrationId === migrationId);
const updated = existing >= 0
  ? prev.map((e, i) => i === existing ? { migrationId, v1Sha256, v2Sha256 } : e)
  : [...prev, { migrationId, v1Sha256, v2Sha256 }];
```
Never use positional index. Pitfall 5 in RESEARCH.

### Pattern G: Internal Error Class (not re-exported from `src/index.ts`)

**Source:** `src/snapshot/read.ts` lines 10–12; `src/user-entities/load.ts` lines 19–21; `src/scaffold/create.ts` lines 43–45
**Apply to:** Any new internal error in `src/validate/` or `src/scaffold/regenerate.ts`
```typescript
// Internal — NOT re-exported from src/index.ts
export class EDBValidateError extends EDBMigrationError {
  readonly code = 'EDB_VALIDATE_ERROR' as const;
}
```
New error codes must be added to `src/errors/codes.ts` `ERROR_CODES` map (pattern from lines 10–18) before being used. Phase 7 validate findings are NOT `EDB*` errors — they are `ValidationFinding[]` objects surfaced by the CLI. Only fatal infrastructure errors (e.g., missing migration folder, snapshot read failure during validate) use `EDB*` codes.

### Pattern H: `jiti` Per-Call for Entity Loading (never reuse instance)

**Source:** `src/user-entities/load.ts` lines 47–67 (with the Pitfall 4 comment)
**Apply to:** `src/validate/context.ts` (entity loading portion)

The full comment block in `load.ts` lines 26–45 explains WHY this is required. Copy the comment into `context.ts` as a single-sentence reference: `// Per-call jiti with caches disabled — see src/user-entities/load.ts Pitfall 4.`

---

## Structural Decisions for the Planner

### Decision S1: Validate barrel ownership

`src/validate/index.ts` MUST be owned by a single plan. Recommended: the final plan in the validate wave (whichever plan wires `runAllRules` to the CLI command). All other validate plans export from their specific module paths; `index.ts` is the last thing added. This mirrors Phase 4's approach where the barrel was owned by the final command-wiring plan.

### Decision S2: `tests/fixtures/validate/` is separate from `tests/_helpers/sample-migrations/`

`tests/_helpers/sample-migrations/` houses DDB-backed migration fixtures (with `createUserAddStatusMigration(client, table)` factory pattern — requires a DDB client). Phase 7's validate rules are PURE FS — they use entity metadata structs and snapshot files directly, never DDB.

Place Phase 7 fixtures at `tests/fixtures/validate/` (per RESEARCH Wave 0 Gaps). The fixture shape is:
- `tests/fixtures/validate/<rule-name>/happy/` — a minimal FS layout that makes the rule return zero findings.
- `tests/fixtures/validate/<rule-name>/fail/` — a minimal FS layout that makes the rule return findings.

Fixture entities for validate tests are lightweight hand-constructed `EntityMetadata` objects (same pattern as `tests/unit/scaffold/create.test.ts` lines 47–66 where `userModel()` is constructed in-memory). Validate tests do NOT need jiti to load entity files — they construct `ValidateContext` directly with `liveEntities: new Map([['User', {...}]])`.

### Decision S3: `create --regenerate` extends `create.ts` directly

See the analog assignment for `src/cli/commands/create.ts` above. The planner should NOT create `src/cli/commands/regenerate.ts` as a separate top-level command file. The `--regenerate <id>` option belongs on the existing `create` command per README §4 / SCF-08. A separate command file would require either a new commander subcommand or complex command-aliasing, both of which deviate from the project's established `registerXxxCommand` pattern.

The planner should plan one task in the `create.ts` plan for adding the `--regenerate` option and the dynamic-import call to `scaffold/regenerate.ts`. The `scaffold/regenerate.ts` orchestrator is a separate plan (it has enough logic to warrant its own task set).

### Decision S4: No source-scan glob extension for `src/validate/`

The project has a `source-scan` test at `tests/_helpers/source-scan.ts` that checks `ConsistentRead: true` in lock/guard modules. `src/validate/` is a pure-FS layer — no DDB I/O, no lock rows, no guard. Do NOT extend the source-scan glob to include `src/validate/`. The relevant invariant for Phase 7 is the inverse: ensure no DDB calls appear in `src/validate/` (SC-1). This can be verified by a simple `grep` assertion in `tests/unit/validate/exit-code.test.ts` or a dedicated `tests/unit/validate/no-ddb.test.ts` file.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `tests/unit/validate/performance.test.ts` | test | batch | No performance/timing test exists in the project; this is the first test that must measure wall-clock time against a budget. Use `performance.now()` from `node:perf_hooks`. Pattern: create a temp dir with 20 synthetic entity-metadata entries + 40 migration folders (via `mkdtempSync`), call `buildValidateContext` + `runAllRules`, assert elapsed < 2000ms (headroom vs the 1s SC-1 budget). |

---

## Metadata

**Analog search scope:** `src/cli/commands/`, `src/scaffold/`, `src/snapshot/`, `src/drift/`, `src/rollback/`, `src/user-entities/`, `tests/unit/cli/`, `tests/unit/scaffold/`, `tests/unit/snapshot/`, `tests/_helpers/`
**Files scanned:** 22 source files, 6 test files
**Pattern extraction date:** 2026-05-09
