import type { EntityProjection, ProjectedAttribute, ProjectedIndex } from '../safety/fingerprint-projection.js';
import { canonicalJson } from '../snapshot/canonical.js';

/**
 * Eight-kind drift classifier (DRF-05). Pure function over two
 * `EntityProjection`s; emits a deterministic `Drift[]` ordered by the
 * kind sequence locked in RESEARCH §Pattern 1, alphabetical within each
 * kind. DRF-06 (behavior-only changes do not trigger drift) falls out
 * for free because Phase 1's projection allowlist
 * (`src/safety/fingerprint-projection.ts`) already strips closures,
 * validators, and sparse-index conditions upstream.
 *
 * Consumed by:
 * - `commands/create` (drift detection — refuse without `--force` when empty per SCF-07)
 * - `validate/rules/drift-without-migration` (Phase 7)
 *
 * @see README §10.2
 */

/* ----- Public types --------------------------------------------------- */

export type DriftKind = 'attribute-added' | 'attribute-removed' | 'attribute-changed' | 'index-added' | 'index-removed' | 'index-changed' | 'key-rename' | 'entity-removed';

export type AttributeChangeField = 'type' | 'required' | 'enumArray' | 'template' | 'padding' | 'properties' | 'items' | 'hidden' | 'readOnly' | 'field';

export type IndexChangeField =
  | 'pk.composite'
  | 'sk.composite'
  | 'pk.template'
  | 'sk.template'
  | 'pk.casing'
  | 'sk.casing'
  | 'pk.prefix'
  | 'sk.prefix'
  | 'pk.postfix'
  | 'sk.postfix'
  | 'pk.field'
  | 'sk.field'
  | 'type'
  | 'collection';

export interface AttributeAdded {
  kind: 'attribute-added';
  name: string;
  type: ProjectedAttribute['type'];
  required: boolean;
  /** True iff `required` is true. Projection has no `default` field — defaults are upstream behavior. */
  warnNeedsDefault: boolean;
}

export interface AttributeRemoved {
  kind: 'attribute-removed';
  name: string;
  type: ProjectedAttribute['type'];
}

export interface AttributeChanged {
  kind: 'attribute-changed';
  name: string;
  changes: ReadonlyArray<{ field: AttributeChangeField; from: unknown; to: unknown }>;
}

export interface IndexAdded {
  kind: 'index-added';
  name: string;
  pkComposite: readonly string[];
  skComposite?: readonly string[];
}

export interface IndexRemoved {
  kind: 'index-removed';
  name: string;
}

export interface IndexChanged {
  kind: 'index-changed';
  name: string;
  changes: ReadonlyArray<{ field: IndexChangeField; from: unknown; to: unknown }>;
}

export interface KeyRename {
  kind: 'key-rename';
  index: string;
  keyType: 'pk' | 'sk';
  from: string;
  to: string;
}

export interface EntityRemoved {
  kind: 'entity-removed';
  entity: string;
  service: string;
}

export type Drift = AttributeAdded | AttributeRemoved | AttributeChanged | IndexAdded | IndexRemoved | IndexChanged | KeyRename | EntityRemoved;

/* ----- Allowlists (locked) -------------------------------------------- */

/**
 * Closed allowlist of attribute fields contributing to drift detection.
 * Mirrors `ProjectedAttribute` fields. Order is alphabetical to match the
 * deterministic emission order spec'd in RESEARCH §Pattern 1.
 */
const ATTRIBUTE_CHANGE_FIELDS: ReadonlyArray<AttributeChangeField> = ['enumArray', 'field', 'hidden', 'items', 'padding', 'properties', 'readOnly', 'required', 'template', 'type'];

/**
 * Closed allowlist of index fields contributing to drift detection.
 * Each entry maps to a path in `ProjectedIndex`.
 */
const INDEX_CHANGE_FIELDS: ReadonlyArray<IndexChangeField> = [
  'collection',
  'pk.casing',
  'pk.composite',
  'pk.field',
  'pk.postfix',
  'pk.prefix',
  'pk.template',
  'sk.casing',
  'sk.composite',
  'sk.field',
  'sk.postfix',
  'sk.prefix',
  'sk.template',
  'type',
];

/* ----- Public API ----------------------------------------------------- */

/**
 * Classify drift between two `EntityProjection`s. Both arguments may be
 * `null`: `null` prev means greenfield (used by `baseline`), `null` curr
 * means the entity has been removed.
 *
 * Output ordering is locked: kind sequence first
 * (`entity-removed` → `attribute-added` → `attribute-removed`
 *  → `attribute-changed` → `index-added` → `index-removed`
 *  → `index-changed` → `key-rename`), alphabetical by `name` / `index` /
 * `entity` within each kind.
 */
export function classifyDrift(prev: EntityProjection | null, curr: EntityProjection | null): Drift[] {
  // Step 1: entity removed
  if (prev !== null && curr === null) {
    return [{ kind: 'entity-removed', entity: prev.entity, service: prev.service }];
  }

  // Both null — no-op
  if (prev === null && curr === null) {
    return [];
  }

  // Step 2: greenfield (null prev, non-null curr)
  if (prev === null && curr !== null) {
    return greenfieldDrift(curr);
  }

  // Both non-null — full diff. (Type narrowing: prev !== null && curr !== null.)
  // biome-ignore lint/style/noNonNullAssertion: refined above by control flow
  return computeDrift(prev!, curr!);
}

/* ----- Implementation ------------------------------------------------- */

function greenfieldDrift(curr: EntityProjection): Drift[] {
  const out: Drift[] = [];
  for (const name of Object.keys(curr.attributes).sort()) {
    const attr = curr.attributes[name];
    if (!attr) continue;
    out.push({
      kind: 'attribute-added',
      name,
      type: attr.type,
      required: attr.required,
      warnNeedsDefault: attr.required,
    });
  }
  for (const name of Object.keys(curr.indexes).sort()) {
    const idx = curr.indexes[name];
    if (!idx) continue;
    out.push(buildIndexAdded(name, idx));
  }
  return out;
}

function computeDrift(prev: EntityProjection, curr: EntityProjection): Drift[] {
  const out: Drift[] = [];

  /* Attributes ---------------------------------------------------------- */
  const prevAttrKeys = new Set(Object.keys(prev.attributes));
  const currAttrKeys = new Set(Object.keys(curr.attributes));

  const addedAttrs: string[] = [];
  const removedAttrs: string[] = [];
  const commonAttrs: string[] = [];
  for (const k of currAttrKeys) {
    if (prevAttrKeys.has(k)) commonAttrs.push(k);
    else addedAttrs.push(k);
  }
  for (const k of prevAttrKeys) {
    if (!currAttrKeys.has(k)) removedAttrs.push(k);
  }
  addedAttrs.sort();
  removedAttrs.sort();
  commonAttrs.sort();

  for (const name of addedAttrs) {
    const attr = curr.attributes[name];
    if (!attr) continue;
    out.push({
      kind: 'attribute-added',
      name,
      type: attr.type,
      required: attr.required,
      warnNeedsDefault: attr.required,
    });
  }
  for (const name of removedAttrs) {
    const attr = prev.attributes[name];
    if (!attr) continue;
    out.push({ kind: 'attribute-removed', name, type: attr.type });
  }

  const attrChanges: AttributeChanged[] = [];
  for (const name of commonAttrs) {
    const p = prev.attributes[name];
    const c = curr.attributes[name];
    if (!p || !c) continue;
    const changes = compareAttribute(p, c);
    if (changes.length > 0) {
      attrChanges.push({ kind: 'attribute-changed', name, changes });
    }
  }
  out.push(...attrChanges);

  /* Indexes ------------------------------------------------------------- */
  const prevIdxKeys = new Set(Object.keys(prev.indexes));
  const currIdxKeys = new Set(Object.keys(curr.indexes));

  const addedIdx: string[] = [];
  const removedIdx: string[] = [];
  const commonIdx: string[] = [];
  for (const k of currIdxKeys) {
    if (prevIdxKeys.has(k)) commonIdx.push(k);
    else addedIdx.push(k);
  }
  for (const k of prevIdxKeys) {
    if (!currIdxKeys.has(k)) removedIdx.push(k);
  }
  addedIdx.sort();
  removedIdx.sort();
  commonIdx.sort();

  for (const name of addedIdx) {
    const idx = curr.indexes[name];
    if (!idx) continue;
    out.push(buildIndexAdded(name, idx));
  }
  for (const name of removedIdx) {
    out.push({ kind: 'index-removed', name });
  }

  // Common indexes — compute changes, then optionally collapse to key-rename
  const indexChangedRecords: IndexChanged[] = [];
  const keyRenameRecords: KeyRename[] = [];
  for (const name of commonIdx) {
    const p = prev.indexes[name];
    const c = curr.indexes[name];
    if (!p || !c) continue;
    const changes = compareIndex(p, c);
    if (changes.length === 0) continue;
    const rename = findKeyRename(changes);
    if (rename) {
      keyRenameRecords.push({
        kind: 'key-rename',
        index: name,
        keyType: rename.keyType,
        from: rename.from,
        to: rename.to,
      });
    } else {
      indexChangedRecords.push({ kind: 'index-changed', name, changes });
    }
  }
  out.push(...indexChangedRecords);
  out.push(...keyRenameRecords);

  return out;
}

function buildIndexAdded(name: string, idx: ProjectedIndex): IndexAdded {
  const record: IndexAdded = {
    kind: 'index-added',
    name,
    pkComposite: idx.pk.composite,
  };
  if (idx.sk !== undefined) {
    record.skComposite = idx.sk.composite;
  }
  return record;
}

/* ----- Field-by-field comparators ------------------------------------- */

/**
 * Compare two `ProjectedAttribute`s field-by-field over the locked
 * allowlist. Nested structures (`properties`, `items`, `enumArray`,
 * `padding`) compared via `canonicalJson` so reordered keys don't
 * register as drift but reordered arrays do (positional). Returns the
 * delta array sorted alphabetically by `field`.
 */
function compareAttribute(prev: ProjectedAttribute, curr: ProjectedAttribute): Array<{ field: AttributeChangeField; from: unknown; to: unknown }> {
  const out: Array<{ field: AttributeChangeField; from: unknown; to: unknown }> = [];
  const pBag = prev as unknown as Record<string, unknown>;
  const cBag = curr as unknown as Record<string, unknown>;
  for (const field of ATTRIBUTE_CHANGE_FIELDS) {
    const pVal = pBag[field];
    const cVal = cBag[field];
    if (!deepEqual(pVal, cVal)) {
      out.push({ field, from: pVal, to: cVal });
    }
  }
  return out;
}

/**
 * Compare two `ProjectedIndex`es over the locked allowlist using dotted
 * `pk.<field>` / `sk.<field>` notation. Returns the delta array sorted
 * alphabetically by `field` slug.
 */
function compareIndex(prev: ProjectedIndex, curr: ProjectedIndex): Array<{ field: IndexChangeField; from: unknown; to: unknown }> {
  const out: Array<{ field: IndexChangeField; from: unknown; to: unknown }> = [];
  for (const field of INDEX_CHANGE_FIELDS) {
    const pVal = readIndexField(prev, field);
    const cVal = readIndexField(curr, field);
    // Skip when both are undefined (sk absent on both sides, etc.)
    if (pVal === undefined && cVal === undefined) continue;
    if (!deepEqual(pVal, cVal)) {
      out.push({ field, from: pVal, to: cVal });
    }
  }
  return out;
}

function readIndexField(idx: ProjectedIndex, field: IndexChangeField): unknown {
  if (field === 'type') return idx.type;
  if (field === 'collection') return idx.collection;
  if (field.startsWith('pk.')) {
    const sub = field.slice(3);
    return (idx.pk as unknown as Record<string, unknown>)[sub];
  }
  if (field.startsWith('sk.')) {
    if (idx.sk === undefined) return undefined;
    const sub = field.slice(3);
    return (idx.sk as unknown as Record<string, unknown>)[sub];
  }
  return undefined;
}

/**
 * Apply the key-rename heuristic. If `changes` contains exactly ONE entry
 * AND that entry is `pk.composite` or `sk.composite` AND the from/to arrays
 * are the same length AND exactly one position differs, return rename
 * data. Otherwise return null (caller emits index-changed instead).
 */
function findKeyRename(changes: ReadonlyArray<{ field: IndexChangeField; from: unknown; to: unknown }>): { keyType: 'pk' | 'sk'; from: string; to: string } | null {
  if (changes.length !== 1) return null;
  const change = changes[0];
  if (!change) return null;
  if (change.field !== 'pk.composite' && change.field !== 'sk.composite') return null;
  const from = change.from;
  const to = change.to;
  if (!Array.isArray(from) || !Array.isArray(to)) return null;
  if (from.length !== to.length || from.length === 0) return null;
  let diffIndex = -1;
  for (let i = 0; i < from.length; i += 1) {
    if (from[i] !== to[i]) {
      if (diffIndex !== -1) return null; // more than one position differs
      diffIndex = i;
    }
  }
  if (diffIndex === -1) return null;
  const fromVal = from[diffIndex];
  const toVal = to[diffIndex];
  if (typeof fromVal !== 'string' || typeof toVal !== 'string') return null;
  return {
    keyType: change.field === 'pk.composite' ? 'pk' : 'sk',
    from: fromVal,
    to: toVal,
  };
}

/**
 * Deep-equality via canonical JSON. Two values are equal iff their
 * canonical (sorted-key) JSON serialization is byte-identical. This
 * matches the determinism contract used by Phase 1's fingerprint hash,
 * so two values that fingerprint identically also classify identically.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return canonicalJson(a) === canonicalJson(b);
}
