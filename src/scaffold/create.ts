import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type Drift, classifyDrift } from '../drift/classify.js';
import { EDBMigrationError } from '../errors/base.js';
import { type EntityProjection, fingerprintEntityModel } from '../safety/fingerprint-projection.js';
import { entitySnapshotPath, snapshotPaths } from '../snapshot/paths.js';
import { readEntitySnapshot, readJournal } from '../snapshot/read.js';
import type { EntitySnapshotFile, JournalFile } from '../snapshot/types.js';
import { FRAMEWORK_SNAPSHOT_VERSION } from '../snapshot/version.js';
import { writeEntitySnapshot, writeJournal } from '../snapshot/write.js';
import { renderFrozenEntitySource } from './frozen-snapshot.js';
import { computeIntegrityHash } from './integrity-hash.js';
import { createMigrationId } from './migration-id.js';
import { renderMigrationTemplate } from './templates.js';

/**
 * `scaffold/create.ts` — orchestrates the 12-step transactional flow that
 * `commands/create` (Plan 09) wires to the CLI surface. Composes the Wave-1
 * primitives (drift classifier, frozen-snapshot generator, integrity hash,
 * migration id, ts-morph entity bumper) with Phase 1's snapshot store.
 *
 * **FND-06 lazy-load discipline:** this module STATIC-imports everything
 * EXCEPT `bump-entity-version.ts`. That single ts-morph site is reached via
 * `await import('./bump-entity-version.js')` so the chain
 * `commands/create → scaffold/create → scaffold/bump-entity-version`
 * keeps ts-morph out of the library bundle's static graph (~1.5 MB win).
 *
 * The 12-step ordering (RESEARCH §Transactional ordering of `create` side
 * effects) is locked. The snapshot is updated LAST so a bump failure
 * leaves the user in a recoverable state — folder scaffolded but the
 * snapshot still reads `fromVersion`. The next `create` invocation will
 * detect that disagreement and refuse, surfacing the recovery path.
 */

/**
 * Internal error class — NOT re-exported from `src/index.ts` (already
 * listed in `FORBIDDEN_RUNTIME_KEYS` of the public-surface gate test).
 *
 * Thrown when `create` finds no shape drift and `--force` was not
 * specified. SCF-07 negative path. CLI exit-code 2 (RESEARCH §Pattern 5,
 * "drift not detected and `--force` not given").
 */
export class EDBDriftNotDetectedError extends EDBMigrationError {
  readonly code = 'EDB_DRIFT_NOT_DETECTED' as const;
}

/* ----- Public types --------------------------------------------------- */

export interface ScaffoldCreateArgs {
  /** Project root for snapshot paths + (relative) migrations dir. */
  cwd: string;
  /** Absolute or cwd-relative path; from config.migrations. */
  migrationsDir: string;
  /** Top-level binding of the user's entity (matches `model.entity`). */
  entityName: string;
  /** User-supplied slug; sanitized inside `createMigrationId`. */
  slug: string;
  /** The user's CURRENT `entity.model` instance (post-edits). */
  currentEntityModel: unknown;
  /** Absolute path of the user's entity TS file (for ts-morph bump). */
  sourceFilePath: string;
  /** Bypass no-drift refusal. */
  force: boolean;
  /** Injected clock (epoch ms) — pinned in tests. */
  clock: () => number;
}

export interface ScaffoldCreateResult {
  migrationId: string;
  migrationFolderPath: string;
  drifts: ReadonlyArray<Drift>;
  v1Sha256: string;
  v2Sha256: string;
}

/* ----- Internal helpers ----------------------------------------------- */

/**
 * Phase 1's `readEntitySnapshot` THROWS (wraps ENOENT as
 * `EDBSnapshotMalformedError`) when the file is missing — that's the
 * documented contract. For the `create` orchestrator we need a
 * three-state read: missing (greenfield), present-and-valid, present-but-malformed.
 * The greenfield case is normal flow on an entity's first migration.
 */
function readEntitySnapshotIfExists(path: string): EntitySnapshotFile | null {
  if (!existsSync(path)) return null;
  return readEntitySnapshot(path);
}

function readJournalIfExists(path: string): JournalFile | null {
  if (!existsSync(path)) return null;
  return readJournal(path);
}

/* ----- Orchestrator --------------------------------------------------- */

/**
 * Run the 12-step transactional flow for the user-facing `create` command.
 * The implementation interleaves the locked ordering (RESEARCH §Transactional
 * ordering of `create` side effects, lines 555-577) with the lazy-load
 * discipline for ts-morph.
 *
 * @throws {@link EDBDriftNotDetectedError} when no drift detected and
 *         `args.force` is false.
 * @throws `EDBEntitySourceEditError` (from `bump-entity-version.ts`) when
 *         the user's source cannot be safely edited; in that case the
 *         migration folder DOES exist on disk but the snapshot is NOT
 *         updated (recoverable: `rm -rf <folder>` and retry).
 */
export async function scaffoldCreate(args: ScaffoldCreateArgs): Promise<ScaffoldCreateResult> {
  // Step 1: Read prev snapshot (null if entity is new — greenfield).
  const snapPath = entitySnapshotPath(args.cwd, args.entityName);
  const prevSnapshot = readEntitySnapshotIfExists(snapPath);
  const prevProjection = (prevSnapshot?.projection as EntityProjection | undefined) ?? null;

  // Step 2: Project + fingerprint the current entity model.
  const { projection: currentProjection, fingerprint: currentFingerprint } = fingerprintEntityModel(args.currentEntityModel);

  // Step 3: Classify drift.
  const drifts = classifyDrift(prevProjection, currentProjection);

  // Step 4: Refuse-without-force gate (SCF-07 negative path).
  if (drifts.length === 0 && !args.force) {
    throw new EDBDriftNotDetectedError(`No shape drift detected for entity '${args.entityName}'. Pass --force to scaffold a migration anyway (e.g. for behavior-only changes).`, {
      entityName: args.entityName,
    });
  }

  // Step 5: Derive fromVersion / toVersion from the user's CURRENT
  // model.version. README quick-start has v1 → v2; same logic applies for
  // numeric versions.
  const modelObj = args.currentEntityModel as { version?: string | number } | undefined;
  const rawVersion = modelObj?.version;
  const fromVersion = rawVersion !== undefined ? String(rawVersion) : '1';
  const fromVersionNum = Number(fromVersion);
  if (Number.isNaN(fromVersionNum)) {
    throw new EDBDriftNotDetectedError(`Cannot determine toVersion: '${args.entityName}'.model.version='${fromVersion}' is not numeric.`, {
      entityName: args.entityName,
      fromVersion,
    });
  }
  const toVersion = String(fromVersionNum + 1);

  // Step 6: Build the migration ID.
  const migrationId = createMigrationId({
    entityName: args.entityName,
    slug: args.slug,
    clock: args.clock,
  });

  // Step 7: Resolve migration folder path (cwd-relative if non-absolute).
  const migrationsDirAbs = isAbsolute(args.migrationsDir) ? args.migrationsDir : resolve(args.cwd, args.migrationsDir);
  const migrationFolderPath = join(migrationsDirAbs, migrationId);

  // Step 8: Render the three sources (in-memory only). Greenfield: when
  // there is no prev projection, v1.ts is rendered from the current
  // projection (the user's "first version" baseline).
  const v1Source = renderFrozenEntitySource({
    projection: prevProjection ?? currentProjection,
    version: fromVersion,
  });
  const v2Source = renderFrozenEntitySource({
    projection: currentProjection,
    version: toVersion,
  });
  const migrationSource = renderMigrationTemplate({ migrationId, entityName: args.entityName });

  // Step 9: Compute integrity hashes for the two frozen sources.
  const v1Sha256 = computeIntegrityHash(v1Source);
  const v2Sha256 = computeIntegrityHash(v2Source);

  // Step 11: Write the migration folder (recoverable by `rm -rf`).
  mkdirSync(migrationFolderPath, { recursive: true });
  writeFileSync(join(migrationFolderPath, 'v1.ts'), v1Source, 'utf8');
  writeFileSync(join(migrationFolderPath, 'v2.ts'), v2Source, 'utf8');
  writeFileSync(join(migrationFolderPath, 'migration.ts'), migrationSource, 'utf8');

  // Step 12: Bump the user's source via DYNAMIC import. This is the
  // single ts-morph entry point — `bump-entity-version.ts` is allowlisted
  // in `tests/unit/build/no-tsmorph-in-library.test.ts` and reached via
  // `import()` so the closure stays out of the library bundle.
  const { bumpEntityVersion } = await import('./bump-entity-version.js');
  await bumpEntityVersion({
    sourceFilePath: args.sourceFilePath,
    entityName: args.entityName,
    fromVersion,
    toVersion,
  });

  // Step 13: Update the snapshot LAST (after the bump succeeds). On a
  // pre-step-12 throw the snapshot is untouched — operator recovery is
  // `rm -rf <migrationFolderPath>` and re-run.
  const updatedSnapshot: EntitySnapshotFile = {
    schemaVersion: FRAMEWORK_SNAPSHOT_VERSION,
    fingerprint: `sha256:${currentFingerprint}`,
    projection: currentProjection as unknown as Record<string, unknown>,
    frozenSnapshots: [...(prevSnapshot?.frozenSnapshots ?? []), { migrationId, v1Sha256, v2Sha256 }],
  };
  writeEntitySnapshot(snapPath, updatedSnapshot);

  // Step 14: Update _journal.json if the entity wasn't there before.
  const paths = snapshotPaths(args.cwd);
  const journal = readJournalIfExists(paths.journal);
  const journalEntry = { entity: args.entityName, snapshot: relative(paths.root, snapPath) };
  if (journal === null) {
    const newJournal: JournalFile = {
      schemaVersion: FRAMEWORK_SNAPSHOT_VERSION,
      minSchemaVersion: FRAMEWORK_SNAPSHOT_VERSION,
      entries: [journalEntry],
    };
    writeJournal(paths.journal, newJournal);
  } else if (!journal.entries.find((e) => e.entity === args.entityName)) {
    const updated: JournalFile = {
      schemaVersion: journal.schemaVersion,
      minSchemaVersion: journal.minSchemaVersion,
      entries: [...journal.entries, journalEntry],
    };
    writeJournal(paths.journal, updated);
  }

  // Step 15: Return the result. Step 12 (CLI diff print) is Plan 09's job.
  return { migrationId, migrationFolderPath, drifts, v1Sha256, v2Sha256 };
}
