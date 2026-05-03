import { ERROR_CODES } from './codes.js';

/** Literal type of the migration-in-progress code, derived from ERROR_CODES so
 *  the type predicate does not inline an `EDB_*` string literal — keeps the
 *  source-scan invariant green (Pitfall #8). */
type MigrationInProgressCode = (typeof ERROR_CODES)['MIGRATION_IN_PROGRESS'];

/**
 * Duck-typed checker for `EDBMigrationInProgressError`. README §9.3 documents
 * this as the user-facing way to detect the error in HTTP middleware. Returns
 * `true` if `err.code` matches `ERROR_CODES.MIGRATION_IN_PROGRESS` regardless
 * of the `instanceof` chain — dual-package safe (Pitfall #15).
 *
 * @example
 *   app.use((err, req, res, next) => {
 *     if (isMigrationInProgress(err)) {
 *       res.set('Retry-After', '30');
 *       return res.status(503).json({ error: 'Migration in progress' });
 *     }
 *     next(err);
 *   });
 */
export const isMigrationInProgress = (err: unknown): err is { code: MigrationInProgressCode; details: Record<string, unknown>; message: string } =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ERROR_CODES.MIGRATION_IN_PROGRESS;
