import type { AnyElectroEntity } from '../migrations/types.js';

/**
 * Pitfall 3 mitigation (RBK-08 / RESEARCH lines 617-635).
 *
 * Validates the return value of a custom `rollbackResolver` BEFORE the resolved
 * record is added to the PUT batch. Without this guard, a resolver returning a
 * v2-shaped record (e.g., with extra `status` attribute) would silently corrupt
 * v1 rows when PUT to DynamoDB — a DATA-LOSS hazard.
 *
 * Validation strategy: call `(v1Entity as any).put(result).params()` which is
 * ElectroDB's schema-validation side effect. If `result` doesn't conform to the
 * v1 entity schema (unknown attributes, missing required fields, wrong types),
 * ElectroDB throws an `ElectroValidationError` which we re-throw with
 * `domainKey` context for operator diagnosis.
 *
 * @param v1Entity  - The frozen v1 ElectroDB entity whose schema is the
 *                    authoritative v1 record shape.
 * @param result    - Return value from `rollbackResolver(args)`.
 * @param domainKey - Human-readable key identifying the record (for error context).
 *
 * @returns `{kind: 'delete'}` when result is null (operator chose to delete).
 * @returns `{kind: 'put', v1: record}` when result passes v1 schema validation.
 * @throws Error with `domainKey` context for invalid non-object values.
 * @throws Error with `domainKey` context for v2-shaped records (Pitfall 3).
 */
export async function validateResolverResult(
  v1Entity: AnyElectroEntity,
  result: unknown,
  domainKey: string,
): Promise<{ kind: 'put'; v1: Record<string, unknown> } | { kind: 'delete' }> {
  if (result === null) return { kind: 'delete' };
  if (result === undefined || typeof result !== 'object') {
    throw new Error(
      `rollbackResolver returned invalid value for ${domainKey}: expected v1 record or null, got ${result === undefined ? 'undefined' : typeof result}`,
    );
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity.put not in d.ts
    (v1Entity as any).put(result).params(); // throws on schema mismatch
  } catch (err) {
    throw new Error(
      `rollbackResolver returned non-v1 shape for ${domainKey}: ${(err as Error).message}`,
    );
  }
  return { kind: 'put', v1: result as Record<string, unknown> };
}
