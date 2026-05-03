/**
 * The shape a user passes to `defineConfig`. Every field except `entities`,
 * `migrations`, and `tableName` is optional — defaults are merged at load
 * time (see `config/defaults.ts` and Plan 06's `config/merge.ts`).
 *
 * Documented in README §5.1.
 */
export interface MigrationsConfig {
  /** Entity import path(s) — single string or array of strings. */
  entities: string | readonly string[];
  /** Path to the migrations directory (`src/database/migrations` by convention). */
  migrations: string;
  /** AWS region for the DDB client. May come from CLI/runtime arg instead. */
  region?: string;
  /**
   * The DynamoDB table name. May be a string or a thunk for environment-based
   * resolution (e.g. `() => process.env.TABLE_NAME ?? throw new Error()`).
   */
  tableName: string | (() => string);
  /** Override DDB primary-key attributes and ElectroDB identifier markers. */
  keyNames?: {
    partitionKey?: string;
    sortKey?: string;
    electroEntity?: string;
    electroVersion?: string;
  };
  /** Lock-state-machine tuning. README §5.1.3. */
  lock?: {
    heartbeatMs?: number;
    staleThresholdMs?: number;
    acquireWaitMs?: number;
  };
  /** Guard-wrapper tuning. README §5.1.4. */
  guard?: {
    cacheTtlMs?: number;
    blockMode?: 'all' | 'writes-only';
  };
  /** Remote-execution endpoint. CFG-10 / Phase 9. */
  remote?: {
    url: string;
    apiKey: string;
  };
  /**
   * Per-entity migration start version. Honored by `validate` and the runner.
   * CFG-09. Example: `{ User: { version: 5 } }`.
   */
  migrationStartVersions?: Record<string, { version: number }>;
  /**
   * Runner tuning. CFG-08: `concurrency` slot reserved with default `1` —
   * the v0.1 runner ignores values > 1.
   */
  runner?: {
    concurrency?: number;
  };
}

/**
 * Fully-resolved config — every section field is required, all defaults
 * merged. Every layer below `config/load.ts` receives this shape.
 */
export interface ResolvedConfig {
  entities: readonly string[];
  migrations: string;
  region: string | undefined;
  tableName: string | (() => string);
  keyNames: Required<NonNullable<MigrationsConfig['keyNames']>>;
  lock: Required<NonNullable<MigrationsConfig['lock']>>;
  guard: Required<NonNullable<MigrationsConfig['guard']>>;
  remote: MigrationsConfig['remote'] | undefined;
  migrationStartVersions: NonNullable<MigrationsConfig['migrationStartVersions']>;
  runner: Required<NonNullable<MigrationsConfig['runner']>>;
}
