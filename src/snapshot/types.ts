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
}
