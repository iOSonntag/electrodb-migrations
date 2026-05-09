/**
 * Rollback subsystem public barrel.
 *
 * Explicit named exports only — no `export *` to avoid accidentally exposing
 * internal helpers and to keep the public surface explicit and searchable.
 *
 * Phase 5 / Wave 1 exports:
 *   - Plan 05-02 (preconditions/lifecycle/head-only):
 *       checkPreconditions + RollbackDecision + CheckPreconditionsArgs
 *       determineLifecycleCase
 *       findHeadViolation + MigrationsRow
 *   - Plan 05-03 (identity-stamp + type-table classifier, RBK-04/RBK-11):
 *       classifyOwner, extractDomainKey
 *       classifyTypeTable + TypeTableEntry + TypeTableCounts + ClassifyTypeTableArgs
 *
 * Plan 05-04 modules (audit, resolver-validate, batch-flush) are imported
 * directly by their consumers in Wave 2 strategies and the Wave 3 orchestrator;
 * they do not need to appear on this barrel.
 */
export { checkPreconditions, type RollbackDecision, type CheckPreconditionsArgs } from './preconditions.js';
export { determineLifecycleCase } from './lifecycle-case.js';
export { findHeadViolation, type MigrationsRow } from './head-only.js';

// Identity-stamp utilities (pure functions, RBK-11)
export { classifyOwner, extractDomainKey } from './identity-stamp.js';

// Type-table classifier (AsyncGenerator, RBK-04 + RBK-11)
export {
  classifyTypeTable,
  type TypeTableEntry,
  type TypeTableCounts,
  type ClassifyTypeTableArgs,
} from './type-table.js';
