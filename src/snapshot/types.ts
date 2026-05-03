/**
 * Shape of `.electrodb-migrations/_journal.json` — the index across per-entity
 * snapshot files. Documented in RESEARCH Pattern 6 (Drizzle-style layout).
 */
export interface JournalFile {
  /** schemaVersion for the journal file itself. v0.1 ships version 1. */
  schemaVersion: number;
  /** Minimum version of the framework that can read this journal + snapshots. */
  minSchemaVersion: number;
  /** Ordered list of entity snapshots; relative paths from the journal location. */
  entries: ReadonlyArray<{ entity: string; snapshot: string }>;
}

/**
 * Shape of `.electrodb-migrations/snapshots/<EntityName>.snapshot.json` —
 * one file per snapshotted entity. Documented in RESEARCH Pattern 6.
 *
 * The `projection` field is opaque at the snapshot layer — Plan 08
 * (`safety/fingerprint-projection.ts`) defines the strict `EntityProjection`
 * shape and is the only producer/consumer of its contents.
 */
export interface EntitySnapshotFile {
  /** Per-file schemaVersion; SNP-04 enforces fileVersion <= FRAMEWORK_SNAPSHOT_VERSION. */
  schemaVersion: number;
  /** Hex-encoded SHA-256 of `canonicalJson(projection)`. Prefix `sha256:` for clarity. */
  fingerprint: string;
  /** The allowlisted projection of the entity's `entity.model`. Plan 08 defines the type. */
  projection: Record<string, unknown>;
  /**
   * Per-migration integrity hashes for the frozen `v1.ts` and `v2.ts` files
   * scaffolded by `create`. SNP-03 (Phase 2). Optional and defaulted to []
   * by the writer; v1 (schemaVersion: 1) snapshots may omit this field
   * entirely, in which case the reader treats it as the empty array.
   */
  frozenSnapshots?: ReadonlyArray<{
    migrationId: string;
    v1Sha256: string;
    v2Sha256: string;
  }>;
}
