/**
 * Test-only introspection helper for ElectroDB entities.
 *
 * Background: ElectroDB exposes two model accessors on an `Entity` instance:
 *
 *   `entity.schema` — the raw user-supplied model. **Typed** in `index.d.ts`.
 *                     Useful for `model.service` / `model.entity` / `model.version`.
 *
 *   `entity.model`  — the parsed/normalized internal model with `.schema.attributes`
 *                     (parsed Attribute[]: each has `.type === 'enum'|'string'|'set'|...`
 *                     and `.enumArray` when type is `'enum'`) and `.indexes.*.pk.field`
 *                     (resolved table-field names after `keyFields` overrides applied).
 *                     **Not in the public types.** This helper provides a single typed
 *                     surface so tests can assert against the parsed form without each
 *                     test redeclaring its own `as any` cast.
 *
 * Verified against `.research/electrodb/src/entity.js:62,100` and
 * `.research/electrodb/src/schema.js:129-131,520-540,1229`.
 */

interface ParsedAttribute {
  type: string;
  enumArray?: readonly string[];
  required?: boolean;
  items?: { type: string };
}

interface ParsedIndex {
  pk: { field: string };
  sk: { field: string };
}

export interface ParsedModel {
  entity: string;
  version: string;
  service: string;
  schema: { attributes: Record<string, ParsedAttribute> };
  indexes: Record<string, ParsedIndex>;
}

interface EntityWithModel {
  model: ParsedModel;
}

/** Returns the parsed (normalized) ElectroDB model for an Entity. */
export function parsedModel(entity: unknown): ParsedModel {
  return (entity as EntityWithModel).model;
}

/** Returns the parsed Attribute object for the named attribute. */
export function parsedAttribute(entity: unknown, name: string): ParsedAttribute {
  const attr = parsedModel(entity).schema.attributes[name];
  if (!attr) {
    throw new Error(`No parsed attribute named "${name}" on entity`);
  }
  return attr;
}

interface ServiceWithEntities {
  entities: Record<string, unknown>;
}

/** Returns the registered entities map for an ElectroDB Service. */
export function serviceEntities(service: unknown): Record<string, unknown> {
  return (service as ServiceWithEntities).entities;
}
