/**
 * Canonical CLI exit codes.
 *
 * - `OK` (0): the command ran to completion and produced its declared effect.
 * - `USER_ERROR` (1): operator-fixable failure — config invariant violation,
 *   ts-morph refusal, file-not-found, validation gate. Always paired with a
 *   `log.err(message, remediation)` call. CLI-09.
 * - `DRIFT_NOT_DETECTED` (2): `create` ran without finding any drift and
 *   `--force` was not passed. Mirrors `git diff --exit-code` so CI scripts
 *   can distinguish "nothing to do" from "something went wrong". SCF-07.
 *
 * No other exit codes are defined for v0.1; future codes go through
 * Phase 4+ planning and land here with documentation.
 */
export const EXIT_CODES = {
  OK: 0,
  USER_ERROR: 1,
  DRIFT_NOT_DETECTED: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
