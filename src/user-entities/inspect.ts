/**
 * The metadata `baseline` and `create` extract from a loaded user-entity
 * module. One record per entity-shaped export; a single source file may
 * declare multiple entities.
 */
export interface EntityMetadata {
  /** The exported variable name (e.g. `'User'` for `export const User = ...`). */
  entityName: string;
  /** `entity.model.entity` — ElectroDB's logical entity identifier. */
  modelEntity: string;
  /** `entity.model.service` — ElectroDB's service / collection identifier. */
  modelService: string;
  /** `entity.model.version` — preserved as string OR number (no coercion). */
  modelVersion: string | number;
  /** Absolute path of the source file the entity was loaded from. */
  sourceFilePath: string;
  /** The Entity instance itself, ready for `fingerprintEntityModel(entity.model)`. */
  entityInstance: unknown;
}

/**
 * Iterate `mod`'s exports and emit one `EntityMetadata` per entity-shaped
 * value. The shape predicate is the minimum surface `fingerprintEntityModel`
 * needs to project to a snapshot: `{ model: { entity: string, service: string,
 * version: string | number } }`.
 *
 * Pattern S4 (defensive type narrowing): every field check is `typeof === ...`
 * or an explicit null/undefined guard. Non-object exports (numbers, strings,
 * functions, arrays) are skipped silently — a single source file can
 * legitimately export both an Entity and a constant. The `default` export is
 * subjected to the same shape predicate; it appears as just another key.
 *
 * Output is sorted alphabetically by `entityName` so consumers (`baseline`'s
 * summary table, `create`'s drift comparison) see a deterministic ordering.
 */
export function extractEntityMetadata(mod: Record<string, unknown>, sourceFilePath: string): EntityMetadata[] {
  const out: EntityMetadata[] = [];
  for (const key of Object.keys(mod).sort()) {
    const candidate = mod[key];
    if (typeof candidate !== 'object' || candidate === null) continue;
    const c = candidate as { model?: unknown };
    if (typeof c.model !== 'object' || c.model === null) continue;
    const m = c.model as { entity?: unknown; service?: unknown; version?: unknown };
    if (typeof m.entity !== 'string' || typeof m.service !== 'string') continue;
    if (typeof m.version !== 'string' && typeof m.version !== 'number') continue;
    out.push({
      entityName: key,
      modelEntity: m.entity,
      modelService: m.service,
      modelVersion: m.version,
      sourceFilePath,
      entityInstance: candidate,
    });
  }
  return out;
}
