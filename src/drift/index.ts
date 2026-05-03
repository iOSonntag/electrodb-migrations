/**
 * `src/drift/` barrel — drift-detection layer.
 *
 * Phase 1 ships only the fingerprint re-export from `src/safety/`.
 * Phase 2 (Plan 02-02) adds the eight-kind classifier and renderer:
 * - `classifyDrift` — pure function over two `EntityProjection`s
 * - `renderSchemaDiff` — pure renderer with injected colorizer adapter
 *
 * Both are consumed by the CLI `create` command (Plan 05) and (in
 * Phase 7) by the `validate` rule layer.
 */

export { fingerprintEntityModel } from '../safety/fingerprint-projection.js';
export type { EntityProjection } from '../safety/fingerprint-projection.js';

export { classifyDrift } from './classify.js';
export type {
  AttributeAdded,
  AttributeChanged,
  AttributeChangeField,
  AttributeRemoved,
  Drift,
  DriftKind,
  EntityRemoved,
  IndexAdded,
  IndexChanged,
  IndexChangeField,
  IndexRemoved,
  KeyRename,
} from './classify.js';

export { renderSchemaDiff } from './diff.js';
export type { Colorizer, RenderSchemaDiffOptions } from './diff.js';
