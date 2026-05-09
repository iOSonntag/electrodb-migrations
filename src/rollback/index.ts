/**
 * Phase 5 rollback subsystem public API barrel.
 *
 * Re-exports all public symbols from the rollback modules so consumer
 * plans (05-04 audit, 05-05/06/07 strategies) can import from
 * `'../rollback/index.js'` rather than individual module paths.
 *
 * Named exports only — never `export *` — so the surface stays auditable.
 */

// Identity-stamp utilities (pure functions, RBK-11)
export { classifyOwner, extractDomainKey } from './identity-stamp.js';

// Type-table classifier (AsyncGenerator, RBK-04 + RBK-11)
export {
  classifyTypeTable,
  type TypeTableEntry,
  type TypeTableCounts,
  type ClassifyTypeTableArgs,
} from './type-table.js';
