/**
 * Rollback subsystem public barrel.
 *
 * Explicit named exports only — no `export *` to avoid accidentally exposing
 * internal helpers and to keep the public surface explicit and searchable.
 *
 * Phase 5 / Wave 1 (Plan 05-02) exports:
 *   - checkPreconditions + RollbackDecision + CheckPreconditionsArgs (preconditions.ts)
 *   - determineLifecycleCase (lifecycle-case.ts)
 *   - findHeadViolation + MigrationsRow (head-only.ts)
 *
 * Subsequent Wave 1 plans (05-03, 05-04) add files under src/rollback/ but do
 * not modify this barrel — they integrate via the orchestrator (Plan 05-09).
 */
export { checkPreconditions, type RollbackDecision, type CheckPreconditionsArgs } from './preconditions.js';
export { determineLifecycleCase } from './lifecycle-case.js';
export { findHeadViolation, type MigrationsRow } from './head-only.js';
