import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ResolvedConfig } from '../config/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import { loadMigrationFile } from './load-migration-module.js';

/**
 * Subset of `_migrations` row fields needed for pending-correlation.
 * Status transitions: `pending` → `applied` → `finalized` (or → `failed`; → `reverted`).
 */
interface MigrationsRow {
  id: string;
  status: 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';
  entityName?: string;
  fromVersion?: string;
  toVersion?: string;
}

/**
 * A migration found on disk that has no `_migrations` row OR a row with
 * `status === 'pending'`. This is the unit of work for the apply runner.
 *
 * Open Question 4 disposition: runner discovers from disk. The first persisted
 * `_migrations` row is written at apply-time inside the lock cycle (Plan 08).
 */
export interface PendingMigration {
  /** Migration id, matching the folder name (`<timestamp>-<entity>-<slug>`). */
  id: string;
  /** Source-of-truth entity name; matches `migration.entityName`. */
  entityName: string;
  /** The `from.model.version` of the migration. Decimal-integer string. */
  fromVersion: string;
  /** The `to.model.version` of the migration. Decimal-integer string. */
  toVersion: string;
  /** The loaded `Migration` object (frozen entities + `up`/`down` functions). */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** Absolute path to the `migration.ts` file on disk. */
  path: string;
}

export interface LoadPendingMigrationsArgs {
  config: ResolvedConfig;
  service: MigrationsServiceBundle;
  cwd: string;
}

/**
 * Discover migrations from disk and correlate against `_migrations` rows.
 *
 * **Open Question 4 disposition (Plan 04-04):** runner discovers from disk.
 * This preserves Phase 2's file-system-only contract — `_migrations` rows are
 * advisory (written by the runner at apply-time) and not the source-of-truth
 * for "what exists".
 *
 * **Pending = on disk AND (no `_migrations` row OR row.status === 'pending').**
 * Rows with status `applied`, `finalized`, `failed`, or `reverted` are NOT
 * pending. Failed migrations require `rollback` (Phase 5) before retry — the
 * runner refuses to re-apply them (T-04-04-04 mitigation).
 *
 * **Sort order:** ascending by `(entityName, Number(fromVersion))`. Stable.
 * Cross-entity sort is alphabetic on `entityName`; intra-entity by numeric
 * `fromVersion`. This is the per-entity sequence contract (RUN-06 / Open
 * Question 6 disposition).
 *
 * @returns Sorted pending list. Empty array means RUN-07 "nothing to apply".
 */
export async function loadPendingMigrations(
  args: LoadPendingMigrationsArgs,
): Promise<PendingMigration[]> {
  const dir = resolve(args.cwd, args.config.migrations);

  // Walk the migrations directory. On failure (ENOENT, etc.) return [] — no
  // pending migrations if the directory does not exist. This also short-circuits
  // the scan call (LP-1 invariant: scan is NOT called when the dir is empty/absent).
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  // If the directory is present but empty, skip the scan call entirely.
  if (entries.length === 0) {
    return [];
  }

  // Load each migration file. Failures (bad syntax, missing file) are silently
  // skipped — the caller's validate gate (Phase 7) is the appropriate reporter.
  const onDisk: PendingMigration[] = [];
  for (const name of entries) {
    const migPath = join(dir, name, 'migration.ts');
    const mig = await loadMigrationFile(migPath).catch(() => null);
    if (!mig) continue;

    // Extract version markers from the frozen entities. Both `from.model.version`
    // and `to.model.version` are decimal-integer strings per the schema (fromVersion /
    // toVersion field is `type: 'string'`).
    const fromVersion = (mig.from as unknown as { model: { version: string } }).model.version;
    const toVersion = (mig.to as unknown as { model: { version: string } }).model.version;

    onDisk.push({
      id: mig.id,
      entityName: mig.entityName,
      fromVersion,
      toVersion,
      migration: mig,
      path: migPath,
    });
  }

  // Short-circuit: if all disk entries failed to load, skip the scan.
  if (onDisk.length === 0) {
    return [];
  }

  // Read all `_migrations` rows. Cardinality is small (one row per migration ever
  // applied to a project), so a full scan with FilterExpression is acceptable.
  // RUN-07: if every disk migration has a terminal-state row, the scan result will
  // cause all items to be filtered out, returning [].
  const scanResult = (await args.service.migrations.scan.go({ pages: 'all' })) as { data: MigrationsRow[] };
  const byId = new Map<string, MigrationsRow>(scanResult.data.map((r) => [r.id, r]));

  const pending = onDisk.filter((m) => {
    const row = byId.get(m.id);
    // Pending if: no row (never applied) OR row.status === 'pending' (acquired but not committed).
    // NOT pending if: applied, finalized, failed (T-04-04-04), or reverted.
    return !row || row.status === 'pending';
  });

  // Sort ascending by (entityName alphabetic, fromVersion numeric).
  // RUN-06 / Open Question 6: per-entity sequence is the v0.1 contract.
  // Cross-entity ordering is Phase 7 validate (VAL-05).
  pending.sort((a, b) => {
    if (a.entityName !== b.entityName) return a.entityName < b.entityName ? -1 : 1;
    return Number.parseInt(a.fromVersion, 10) - Number.parseInt(b.fromVersion, 10);
  });

  return pending;
}

/**
 * RUN-06 sequence check: per-entity scope (Open Question 6 disposition).
 *
 * Returns `true` iff `migId` is the FIRST pending migration in the list whose
 * `entityName` matches `migId`'s entity. Cross-entity ordering is Phase 7
 * `validate`'s responsibility (VAL-05) and is intentionally NOT enforced here.
 *
 * @param pending - Sorted pending list from `loadPendingMigrations`.
 * @param migId   - The migration id to check.
 * @returns `true` if `migId` is next for its entity; `false` otherwise.
 *
 * @example
 *   // pending = [Team-v1, User-add-status] (cross-entity sorted)
 *   isNextPending(pending, 'User-add-status') // → true (next FOR User entity)
 *   isNextPending(pending, 'Team-v1')         // → true (next FOR Team entity)
 */
export function isNextPending(pending: readonly PendingMigration[], migId: string): boolean {
  const target = pending.find((p) => p.id === migId);
  if (!target) return false;
  const sameEntity = pending.filter((p) => p.entityName === target.entityName);
  return sameEntity.length > 0 && sameEntity[0]!.id === migId;
}
