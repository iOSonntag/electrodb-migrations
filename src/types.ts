/**
 * Mirrors ElectroDB's `EntityConfiguration['identifiers']`. The framework's
 * internal entities accept this so they can sit in a user table where
 * ElectroDB's own `__edb_e__` / `__edb_v__` identifier fields have been
 * renamed. The framework forwards this only when the user explicitly
 * supplied it; otherwise ElectroDB's own defaults apply.
 */
export type IdentifiersConfig = {
  entity?: string;
  version?: string;
};

/**
 * Names of the user's DynamoDB table's primary-key attributes. Defaults to
 * `pk` / `sk`. Set these when your table uses different attribute names
 * (e.g. `PK` / `SK`, `partitionKey` / `sortKey`) — every internal entity
 * uses them when declaring its index.
 */
export type TableKeyConfig = {
  pk?: string;
  sk?: string;
};

/**
 * Options accepted by every internal entity factory. Forwarded from the
 * framework config so `_migration_state`, `_migrations`, and
 * `_migration_runs` can coexist in any user table.
 */
export type InternalEntityOptions = {
  identifiers?: IdentifiersConfig;
  keyFields?: TableKeyConfig;
};

/** Default DynamoDB primary-key attribute names assumed when none configured. */
export const DEFAULT_TABLE_KEYS = { pk: 'pk', sk: 'sk' } as const;
