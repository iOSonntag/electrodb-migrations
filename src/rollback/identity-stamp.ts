/**
 * Identity-stamp utilities for the Phase 5 rollback type-table classifier.
 *
 * Both functions are PURE — no I/O, no side effects. They delegate to
 * ElectroDB's internal API surface (`entity.ownsItem`, `entity.parse`,
 * `entity.schema.indexes.byId.pk.composite`) via `as any` casts because
 * these methods are present at runtime but not fully exposed in ElectroDB's
 * public TypeScript d.ts surface.
 *
 * Source-verified: `.research/electrodb/src/entity.js:146-154` (`ownsItem`).
 *
 * Reference: Plan 05-03, RESEARCH §Section 2 lines 1041-1080,
 * §Pattern 1 lines 263-285, §Pattern 2 lines 303-312.
 */

import type { AnyElectroEntity } from '../migrations/types.js';

/**
 * Classify whether a raw DDB record is owned by the v1 or v2 entity, or
 * belongs to a third entity (returns null).
 *
 * Delegates to ElectroDB's `entity.ownsItem(record)` which checks both
 * `item[identifiers.entity] === entity.getName()` AND
 * `item[identifiers.version] === entity.getVersion()`. This means Team
 * records on the same STD table will correctly return `null` (RBK-11).
 *
 * Source-verified: `.research/electrodb/src/entity.js:146-154`.
 *
 * @param record    - Raw DynamoDB Item (marshalled, with `__edb_e__` / `__edb_v__` markers).
 * @param v1Entity  - Frozen v1 ElectroDB Entity (`migration.from`).
 * @param v2Entity  - Frozen v2 ElectroDB Entity (`migration.to`).
 * @returns `'v1'`, `'v2'`, or `null` if the record is owned by neither.
 */
export function classifyOwner(
  record: Record<string, unknown>,
  v1Entity: AnyElectroEntity,
  v2Entity: AnyElectroEntity,
): 'v1' | 'v2' | null {
  // biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity.ownsItem is not in d.ts
  if ((v1Entity as any).ownsItem(record)) return 'v1';
  // biome-ignore lint/suspicious/noExplicitAny: same
  if ((v2Entity as any).ownsItem(record)) return 'v2';
  return null;
}

/**
 * Extract the user-domain primary-key string for a raw DDB record.
 *
 * Reads `entity.schema.indexes.byId.pk.composite` (an array of attribute
 * names, e.g. `['id']` or `['tenantId', 'id']`) and projects the
 * corresponding values from `entity.parse({Item: record}).data` — the
 * user-domain shape after ElectroDB unmarshals the record.
 *
 * The key is `attribute=value` pairs joined by `&` (e.g., `'id=u-1'` or
 * `'tenantId=t-1&id=u-1'`).
 *
 * **Independence from pk/sk byte sequences (RBK-11):** The function reads
 * attribute values from the PARSED domain shape, not from the raw pk/sk
 * bytes. This means the key is stable across v1 and v2 entities that share
 * the same PK composite attribute list — the union key is consistent even
 * when the byte-level pk/sk differ (B-01 key-shape differentiator).
 *
 * **Pitfall 7 / OQ6:** If v1 and v2 entities define DIFFERENT pk composite
 * attribute lists, this function may produce an incorrect union key. That
 * case is deferred to Phase 7's validate gate (a new VAL rule will refuse
 * such migrations). See RESEARCH OQ6 disposition.
 *
 * @param entity  - ElectroDB Entity (frozen v1 or frozen v2) — provides schema + parse.
 * @param record  - Raw DynamoDB Item (marshalled).
 * @returns Deterministic domain-key string, e.g. `'id=u-1'`.
 */
export function extractDomainKey(
  entity: AnyElectroEntity,
  record: Record<string, unknown>,
): string {
  // biome-ignore lint/suspicious/noExplicitAny: schema/parse not in d.ts
  const e = entity as any;
  const composite: string[] = e.schema.indexes.byId.pk.composite;
  const parsed = e.parse({ Item: record }).data as Record<string, unknown>;
  return composite.map((f) => `${f}=${String(parsed[f])}`).join('&');
}
