/**
 * Base for every EDB-prefixed error the framework throws.
 *
 * Subclasses override `code` (a stable string from `errors/codes.ts`) and may
 * layer additional read-only fields onto `details`. **Do NOT** rely on
 * `instanceof` to detect these errors from user code — under dual ESM/CJS
 * loading the same logical class can have two distinct identities. Use the
 * `is*` duck-typed checkers in `errors/checkers.ts` instead.
 *
 * See README §9.1 + Pitfall #15.
 */
export abstract class EDBMigrationError extends Error {
  abstract readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
  }
}
