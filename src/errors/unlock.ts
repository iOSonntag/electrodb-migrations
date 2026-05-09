import { EDBMigrationError } from './base.js';

/**
 * Internal error class — NOT re-exported from `src/index.ts`. Thrown by
 * `client.forceUnlock(args)` when `args.yes !== true`. Mirrors the CLI's
 * panic-button refusal: the CLI requires `--yes` (or interactive confirmation
 * after rendering the lock-state table); the programmatic API requires the
 * caller to pass `yes: true` explicitly to acknowledge they are bypassing
 * the safety prompt.
 *
 * Design rationale (RESEARCH §Section 7 lines 1414-1421 + REQUIREMENTS.md
 * line 188 — API-05 canonical signature `forceUnlock({runId, yes})`):
 * The alternative (warning-and-proceed default) makes the CLI and programmatic
 * surfaces inconsistent — CLI-05 says the CLI MUST prompt; if the programmatic
 * API silently proceeds it would let library consumers accidentally bypass an
 * operator-deliberate guard.
 *
 * This is the BLOCKER 2 design: programmatic `forceUnlock` requires explicit
 * `yes: true` to acknowledge bypassing the interactive confirmation flow
 * (RESEARCH §Section 7). The caller that intends to force-unlock a lock must
 * explicitly declare intent rather than relying on a default that silently
 * proceeds.
 *
 * Caller's remediation:
 * - If you intend to bypass interactive confirmation: pass `yes: true`.
 * - If you want interactive confirmation: use the CLI
 *   (`electrodb-migrations unlock --run-id <X>`).
 */
export class EDBUnlockRequiresConfirmationError extends EDBMigrationError {
  readonly code = 'EDB_UNLOCK_REQUIRES_CONFIRMATION' as const;
}
