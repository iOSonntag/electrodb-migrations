/**
 * Migration ID + slug + timestamp utilities. SCF-02.
 *
 * Pure functions over user input + an injected clock. Anti-Pattern 5:
 * the wall clock is NEVER read directly inside this module — always
 * passed in by the caller so tests (and future schedulers) can pin the
 * timestamp. Plan 07's scaffold orchestrator wires the real-time clock
 * at the CLI layer.
 *
 * Slug sanitizer rules (RESEARCH §Don't Hand-Roll table):
 * - lowercase
 * - non-alphanumeric runs collapsed to a single '-'
 * - leading/trailing '-' trimmed
 * - throws if the result is empty
 *
 * Path-traversal guards on `entityName` mirror Phase 1's
 * `entitySnapshotPath` invariant (src/snapshot/paths.ts:44-53). The
 * migration ID flows downstream into directory names like
 * `migrations/<id>/`, so any '/' or '\\' or '..' in entityName would
 * escape the migrations folder.
 */

/**
 * Lowercase + collapse non-alphanumeric runs to '-' + trim leading and
 * trailing '-'. Throws if the result is empty.
 *
 * Examples:
 * - `'add-status'`  → `'add-status'`
 * - `'Add Status!'` → `'add-status'`
 * - `'a..b'`        → `'a-b'`     (path-traversal segments collapsed)
 * - `'!!!'`         → throws       (sanitizes to empty)
 */
export function sanitizeSlug(input: string): string {
  const collapsed = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed.length === 0) {
    throw new Error(`sanitizeSlug: input "${input}" sanitized to empty string. Slug must contain at least one alphanumeric character.`);
  }
  return collapsed;
}

/**
 * Format an epoch-millisecond timestamp as `YYYYMMDDHHMMSS` in UTC.
 *
 * UTC-only (uses `getUTC*` accessors) so the output is independent of
 * `process.env.TZ` and the host's locale. README §4 quick start example:
 * `Date.UTC(2026, 4, 1, 8, 30, 0)` → `'20260501083000'`.
 */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mi = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

export interface CreateMigrationIdArgs {
  /**
   * The ElectroDB entity name. Preserved verbatim (NOT sanitized) — it
   * is validated upstream by `projectEntityModel`'s shape contract.
   * Must NOT contain `'/'`, `'\\'`, or `'..'` (path-traversal guard).
   */
  entityName: string;
  /**
   * The user-supplied slug (e.g. `'add-status'`). Sanitized via
   * `sanitizeSlug` before interpolation; throws on empty-after-sanitize.
   */
  slug: string;
  /**
   * Injected clock — must return epoch milliseconds. Tests pin this.
   * Anti-Pattern 5 (RESEARCH §548): never read the wall clock directly
   * inside this module.
   */
  clock: () => number;
}

/**
 * Build a migration ID of the form `<YYYYMMDDHHMMSS>-<entity>-<slug>`.
 *
 * @throws if `entityName` is empty or contains path-traversal characters,
 *         or if `slug` sanitizes to the empty string.
 */
export function createMigrationId(args: CreateMigrationIdArgs): string {
  if (args.entityName.length === 0) {
    throw new Error('createMigrationId: entityName must be non-empty');
  }
  if (args.entityName.includes('/') || args.entityName.includes('\\') || args.entityName.includes('..')) {
    throw new Error(`createMigrationId: invalid entityName "${args.entityName}" — must not contain path separators or '..'`);
  }
  const sanitizedSlug = sanitizeSlug(args.slug); // throws on empty-after-sanitize
  const timestamp = formatTimestamp(args.clock());
  return `${timestamp}-${args.entityName}-${sanitizedSlug}`;
}
