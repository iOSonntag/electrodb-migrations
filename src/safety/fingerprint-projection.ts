import { createHash } from 'node:crypto';
import { canonicalJson } from '../snapshot/canonical.js';

/**
 * Closed allowlist of attribute fields that contribute to fingerprint identity.
 * Adding a new ElectroDB attribute field requires a snapshot version bump
 * (SNP-04) so older readers detect the schema skew.
 *
 * Sources of truth:
 * - `.research/electrodb/src/schema.js:104-150` (Attribute constructor)
 * - `.research/electrodb/src/entity.js:5180-5306` (`_parseModel` return shape)
 * - RESEARCH `Pattern 5 — Fingerprint Projection Allowlist` + Allowlist tables
 *
 * Q1 disposition: `template`, `padding`, `prefix`, `postfix`, `casing` ARE
 * shape-affecting (changes alter stored DDB key bytes). INCLUDED.
 *
 * Q2 disposition: `watching`/`watchedBy`/`watchAll` are behavior-only
 * (computed-attribute side effects don't change stored shape). EXCLUDED.
 * Documented in DRF-06: behavior-only changes do NOT trigger drift.
 */
export interface ProjectedAttribute {
  type: string | readonly string[];
  required: boolean;
  hidden: boolean;
  readOnly: boolean;
  field: string;
  enumArray?: readonly string[];
  /** Recursive — for `map` types. */
  properties?: Record<string, ProjectedAttribute>;
  /** Recursive — for `list` types; or string for `set` of primitive. */
  items?: ProjectedAttribute | string;
  /** Key-affecting fixings on `string` attributes used in keys. */
  template?: string;
  padding?: { length: number; char: string };
}

export interface ProjectedKey {
  field: string;
  composite: readonly string[];
  casing?: string;
  template?: string;
  prefix?: string;
  postfix?: string;
}

export interface ProjectedIndex {
  type: 'isolated' | 'clustered';
  pk: ProjectedKey;
  sk?: ProjectedKey;
  collection?: string | readonly string[];
}

export interface EntityProjection {
  entity: string;
  service: string;
  // model.version intentionally EXCLUDED (DRF-03)
  attributes: Record<string, ProjectedAttribute>;
  indexes: Record<string, ProjectedIndex>;
}

/* ----- Walker --------------------------------------------------------- */

function projectAttribute(raw: unknown): ProjectedAttribute {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('projectAttribute: expected attribute object');
  }
  const a = raw as Record<string, unknown>;
  const out: ProjectedAttribute = {
    type: a.type as ProjectedAttribute['type'],
    required: Boolean(a.required),
    hidden: Boolean(a.hidden),
    readOnly: Boolean(a.readOnly),
    field: typeof a.field === 'string' ? a.field : '',
  };
  if (Array.isArray(a.enumArray)) {
    out.enumArray = [...(a.enumArray as readonly string[])];
  }
  if (a.properties && typeof a.properties === 'object') {
    const props: Record<string, ProjectedAttribute> = {};
    const rawProps = a.properties as Record<string, unknown>;
    for (const k of Object.keys(rawProps)) {
      props[k] = projectAttribute(rawProps[k]);
    }
    out.properties = props;
  }
  if (a.items !== undefined) {
    if (typeof a.items === 'string') {
      out.items = a.items;
    } else if (typeof a.items === 'object' && a.items !== null) {
      out.items = projectAttribute(a.items);
    }
  }
  if (typeof a.template === 'string') {
    out.template = a.template;
  }
  if (a.padding && typeof a.padding === 'object') {
    const p = a.padding as { length?: unknown; char?: unknown };
    if (typeof p.length === 'number' && typeof p.char === 'string') {
      out.padding = { length: p.length, char: p.char };
    }
  }
  return out;
}

function projectKey(raw: unknown): ProjectedKey {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('projectKey: expected key object');
  }
  const k = raw as Record<string, unknown>;
  const out: ProjectedKey = {
    field: typeof k.field === 'string' ? k.field : '',
    composite: Array.isArray(k.composite) ? [...(k.composite as readonly string[])] : [],
  };
  if (typeof k.casing === 'string') out.casing = k.casing;
  if (typeof k.template === 'string') out.template = k.template;
  if (typeof k.prefix === 'string') out.prefix = k.prefix;
  if (typeof k.postfix === 'string') out.postfix = k.postfix;
  return out;
}

function projectIndex(raw: unknown): ProjectedIndex {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('projectIndex: expected index object');
  }
  const i = raw as Record<string, unknown>;
  const indexType = i.type === 'clustered' ? 'clustered' : 'isolated';
  const out: ProjectedIndex = {
    type: indexType,
    pk: projectKey(i.pk),
  };
  if (i.sk !== undefined && i.sk !== null) {
    out.sk = projectKey(i.sk);
  }
  if (typeof i.collection === 'string') {
    out.collection = i.collection;
  } else if (Array.isArray(i.collection)) {
    out.collection = [...(i.collection as readonly string[])];
  }
  return out;
}

/**
 * Project an ElectroDB `entity.model` into the closed allowlist shape.
 * DRF-01 + DRF-02 + DRF-03.
 */
export function projectEntityModel(entityModel: unknown): EntityProjection {
  if (typeof entityModel !== 'object' || entityModel === null) {
    throw new Error('projectEntityModel: expected entity.model object');
  }
  const m = entityModel as Record<string, unknown>;
  const schemaCandidate = m.schema as Record<string, unknown> | undefined;
  const schema = schemaCandidate ?? m;
  const attributesRaw = schema.attributes as Record<string, unknown> | undefined;
  const indexesRaw = m.indexes as Record<string, unknown> | undefined;

  if (!attributesRaw || typeof attributesRaw !== 'object') {
    throw new Error('projectEntityModel: model.schema.attributes missing');
  }
  if (!indexesRaw || typeof indexesRaw !== 'object') {
    throw new Error('projectEntityModel: model.indexes missing');
  }

  const attributes: Record<string, ProjectedAttribute> = {};
  for (const k of Object.keys(attributesRaw)) {
    attributes[k] = projectAttribute(attributesRaw[k]);
  }
  const indexes: Record<string, ProjectedIndex> = {};
  for (const k of Object.keys(indexesRaw)) {
    indexes[k] = projectIndex(indexesRaw[k]);
  }

  return {
    entity: typeof m.entity === 'string' ? m.entity : '',
    service: typeof m.service === 'string' ? m.service : '',
    attributes,
    indexes,
  };
}

/**
 * Compute the SHA-256 fingerprint of an ElectroDB entity model. The
 * projection is canonicalized (sorted keys, recursive) before hashing so
 * the digest is deterministic across Node versions, OSes, and ElectroDB
 * minor releases. DRF-04. Pitfall #5.
 */
export function fingerprintEntityModel(entityModel: unknown): {
  projection: EntityProjection;
  fingerprint: string;
} {
  const projection = projectEntityModel(entityModel);
  const json = canonicalJson(projection);
  const fingerprint = createHash('sha256').update(json).digest('hex');
  return { projection, fingerprint };
}
