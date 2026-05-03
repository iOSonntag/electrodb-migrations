/**
 * MUST be passed as `ConsistentRead` on every `GetItem` of the
 * `_migration_state` row.
 *
 * Pitfall #1 — DynamoDB defaults to eventually-consistent reads. Combined
 * with `guard.cacheTtlMs = 5s`, an eventually-consistent read can return
 * `lockState='free'` seconds after the runner wrote `lockState='apply'`.
 * DynamoDB Local does NOT catch this (it is strongly-consistent by default).
 * The constant is the literal `true` (not configurable). README §5.3.
 *
 * Phase 3's `lock/` and `guard/` import this module and pass `ConsistentRead:
 * CONSISTENT_READ` (the named import — NOT a literal `true`) so that source-
 * scan code review can grep for omissions.
 */
export const CONSISTENT_READ = true as const;

/**
 * Lint-grep marker. Code review checklist item (enforced in Phase 3): every
 * `GetItem` against `_migration_state` MUST include `ConsistentRead:
 * CONSISTENT_READ` referencing the named import.
 */
export const CONSISTENT_READ_MARKER = '@electrodb-migrations/consistent-read' as const;
