/**
 * `buildCtx` — Phase 6 ctx factory. Constructs a typed `MigrationCtx` for the
 * runner to pass into `up()` (apply path) and `down()` (rollback path).
 *
 * **Pre-flight strategy (RESEARCH §OQ4):**
 *   - For every entity in `migration.reads` (declared targets):
 *       1. Self-read check (CTX-04): if entity name === migration.entityName,
 *          throw `EDBSelfReadInMigrationError`.
 *       2. Fingerprint check (CTX-05): read the on-disk snapshot for the entity;
 *          compute the imported entity's fingerprint via `fingerprintEntityModel`;
 *          if they mismatch, throw `EDBStaleEntityReadError` BEFORE any v2 write.
 *       3. Cache the validated facade in `Map<entityName, ReadOnlyFacadeRuntime>`.
 *   - For undeclared targets (called via `ctx.entity(Y)` where Y is not in
 *     `migration.reads`), validation runs lazily at first call and caches.
 *
 * **Why eager for declared (CTX-06 + CTX-05):** if the migration declares
 * `reads:[Team]` and Team's snapshot is stale, the migration WILL hit the
 * stale-read path eventually. Catching it BEFORE any v2 write keeps the table
 * recoverable (no half-migrated state). The lazy path for undeclared targets
 * exists because the runner doesn't know which entities `up()` will reference.
 *
 * **Why the cache (RESEARCH §OQ4 / OQ8):** validation reads a file from disk.
 * Per-record validation would dominate runtime for million-row tables. The
 * cache is per-run and in-memory; it is correct because the snapshot fingerprint
 * is fixed at run-start (any file edits during a run are not picked up — the
 * runner already loaded the migration's frozen entity references at module load).
 *
 * **Pitfall 3 wrap (RESEARCH lines 563-567):** when `readEntitySnapshot` throws
 * `EDBSnapshotMalformedError` (file absent or unreadable), surface a user-actionable
 * remediation message pointing at `electrodb-migrations baseline`. The wrapped
 * error preserves the underlying cause via the `cause` field.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fingerprintEntityModel } from '../safety/index.js';
import { EDBSnapshotMalformedError, readEntitySnapshot, entitySnapshotPath } from '../snapshot/index.js';
import { EDBStaleEntityReadError, EDBSelfReadInMigrationError } from '../errors/index.js';
import { createReadOnlyFacade } from './read-only-facade.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { MigrationCtx } from './types.js';

type ReadOnlyFacadeRuntime = ReturnType<typeof createReadOnlyFacade>;

/**
 * Read the on-disk snapshot for `entityName` and return its stored fingerprint.
 * Wraps `readEntitySnapshot`'s `EDBSnapshotMalformedError` with a remediation
 * message (Pitfall 3).
 */
function readSnapshotFingerprint(cwd: string, entityName: string, migrationId: string): string {
  const snapshotPath = entitySnapshotPath(cwd, entityName);
  try {
    const snapshot = readEntitySnapshot(snapshotPath);
    return snapshot.fingerprint;
  } catch (err) {
    if (err instanceof EDBSnapshotMalformedError) {
      // Surface a user-actionable error: snapshot file is missing or malformed.
      // The migration declares (or attempts) a read of `entityName` but the
      // framework has no on-disk record of `entityName`'s shape.
      const wrapped: Error & { code?: string; remediation?: string; cause?: unknown } = new Error(
        `Cannot read snapshot for entity '${entityName}' (required by migration '${migrationId}'). ` +
          `Run \`electrodb-migrations baseline\` to create snapshots for all known entities.`,
      );
      wrapped.code = 'EDB_SNAPSHOT_MALFORMED';
      wrapped.remediation = `Run \`electrodb-migrations baseline\` to create a snapshot for entity '${entityName}'.`;
      wrapped.cause = err;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Compute the entity-name string from an `AnyElectroEntity` reference. Mirrors
 * the access pattern used in `src/runner/apply-flow.ts:132`.
 */
function entityNameOf(entity: AnyElectroEntity): string {
  return (entity as unknown as { model: { entity: string } }).model.entity;
}

/**
 * Construct a `MigrationCtx` for the given `migration`, bound to `docClient`.
 * Performs eager pre-flight validation for every entity in `migration.reads`.
 *
 * @param migration  - The migration about to run (apply or rollback).
 * @param docClient  - The runner's UNGUARDED DynamoDBDocumentClient.
 * @param tableName  - The user's DynamoDB table name.
 * @param cwd        - The user's project root (used for snapshot path resolution).
 * @returns A `MigrationCtx` whose `entity(Other)` method enforces CTX-03/04/05.
 * @throws `EDBSelfReadInMigrationError` — declared self-read in `reads`.
 * @throws `EDBStaleEntityReadError` — declared `reads` target's fingerprint mismatch.
 * @throws Wrapped `Error{code:'EDB_SNAPSHOT_MALFORMED'}` — declared target has no snapshot file.
 */
export async function buildCtx(
  migration: Migration<AnyElectroEntity, AnyElectroEntity>,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  cwd: string,
): Promise<MigrationCtx> {
  const cache = new Map<string, ReadOnlyFacadeRuntime>();

  // -------------------------------------------------------------------------
  // Eager pre-flight for declared `reads` (CTX-05 declared path / OQ4).
  // -------------------------------------------------------------------------
  for (const declared of migration.reads ?? []) {
    const declaredName = entityNameOf(declared);

    // CTX-04 (declared path): a migration cannot read its own entity.
    if (declaredName === migration.entityName) {
      throw new EDBSelfReadInMigrationError(
        `Migration '${migration.id}' declares reads: [${declaredName}] — a migration cannot read its own entity.`,
        { migrationId: migration.id, entityName: declaredName },
      );
    }

    // CTX-05 (declared path): on-disk fingerprint must match imported source.
    const onDiskFingerprint = readSnapshotFingerprint(cwd, declaredName, migration.id);
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity has a 5-param generic; reading `.model` crosses the boundary.
    const { fingerprint: importedFingerprint } = fingerprintEntityModel((declared as any).model);
    if (onDiskFingerprint !== importedFingerprint) {
      throw new EDBStaleEntityReadError(
        `ctx.entity('${declaredName}'): on-disk snapshot fingerprint does not match the imported entity. ` +
          `A later migration on '${declaredName}' has been applied. Sequence that migration before '${migration.id}'.`,
        {
          entityName: declaredName,
          migrationId: migration.id,
          onDisk: onDiskFingerprint,
          imported: importedFingerprint,
        },
      );
    }

    cache.set(declaredName, createReadOnlyFacade(declared, docClient, tableName));
  }

  // -------------------------------------------------------------------------
  // Return the MigrationCtx. The `entity()` method handles undeclared lazy
  // validation (CTX-04 runtime + CTX-05 lazy paths).
  // -------------------------------------------------------------------------
  return {
    entity(other) {
      const otherName = entityNameOf(other);

      // CTX-04 (runtime path): self-read catches both declared and undeclared
      // attempts. The declared case has already been caught above; this is
      // the safety net for `migration.reads = []` + `ctx.entity(self)`.
      if (otherName === migration.entityName) {
        throw new EDBSelfReadInMigrationError(
          `ctx.entity('${otherName}') called from inside '${otherName}' migration — self-reads are not permitted.`,
          { migrationId: migration.id, entityName: otherName },
        );
      }

      // Cache hit: declared targets are pre-cached; undeclared targets are
      // cached on first call.
      const cached = cache.get(otherName);
      if (cached) {
        // biome-ignore lint/suspicious/noExplicitAny: Runtime facade ↔ public ReadOnlyEntityFacade<E> generic boundary.
        return cached as any;
      }

      // CTX-05 lazy path: validate fingerprint at first call for undeclared targets.
      const onDiskFingerprint = readSnapshotFingerprint(cwd, otherName, migration.id);
      // biome-ignore lint/suspicious/noExplicitAny: same ElectroDB-generic boundary as above.
      const { fingerprint: importedFingerprint } = fingerprintEntityModel((other as any).model);
      if (onDiskFingerprint !== importedFingerprint) {
        throw new EDBStaleEntityReadError(
          `ctx.entity('${otherName}'): on-disk snapshot fingerprint does not match the imported entity.`,
          {
            entityName: otherName,
            migrationId: migration.id,
            onDisk: onDiskFingerprint,
            imported: importedFingerprint,
          },
        );
      }

      const facade = createReadOnlyFacade(other, docClient, tableName);
      cache.set(otherName, facade);
      // biome-ignore lint/suspicious/noExplicitAny: Runtime facade ↔ public ReadOnlyEntityFacade<E> generic boundary.
      return facade as any;
    },
  };
}
