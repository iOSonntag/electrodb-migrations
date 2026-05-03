/**
 * The shape a user passes to `defineConfig`. Every field is optional —
 * `entities` and `migrations` get built-in path defaults (CFG-12), and the
 * post-merge invariants pass asserts that `tableName` (and, when set,
 * `remote.url` + `remote.apiKey`) reach the resolved config from some layer.
 * Defaults are merged at load time (see `config/defaults.ts` and
 * `config/merge.ts`); invariants are asserted by `config/invariants.ts`.
 *
 * Documented in README §5.1.
 */
export interface MigrationsConfig {
  /** Entity import path(s) — single string or array of strings. Defaults to `'src/database/entities'`. */
  entities?: string | readonly string[];
  /** Path to the migrations directory. Defaults to `'src/database/migrations'`. */
  migrations?: string;
  /** AWS region for the DDB client. May come from CLI/runtime arg instead. */
  region?: string;
  /**
   * The DynamoDB table name. May be a string or a thunk for environment-based
   * resolution (e.g. `() => process.env.TABLE_NAME ?? throw new Error()`).
   * Optional in the file: may also come from `--table` on the CLI or as a
   * runtime arg. The framework throws `EDBConfigInvariantViolationError` at
   * start if no layer supplies it.
   */
  tableName?: string | (() => string);
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
  /**
   * Remote-execution endpoint. CFG-10 / Phase 9.
   * Both fields are optional in the file (so a CLI flag or runtime arg can
   * supply one half), but when `remote` is defined on the resolved config
   * the invariants pass requires both `url` and `apiKey` to be non-empty.
   */
  remote?: {
    url?: string;
    apiKey?: string;
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
 * Fully-resolved config — every section that has a built-in default is
 * filled; `tableName` is widened to include `undefined` here because the
 * framework cannot synthesize one from defaults. The post-merge invariants
 * pass (`validateConfigInvariants`) narrows it back to a non-empty string
 * (or thunk) and asserts that, when `remote` is set, both inner fields are
 * present. Every layer below `config/load.ts` receives this shape.
 */
export interface ResolvedConfig {
  entities: readonly string[];
  migrations: string;
  region: string | undefined;
  /**
   * Widened to include `undefined` until `validateConfigInvariants` runs;
   * downstream consumers can rely on it being non-empty (string or thunk)
   * once the invariants pass has executed.
   */
  tableName: string | (() => string) | undefined;
  /**
   * Resolved key-name overrides. `partitionKey` / `sortKey` are always
   * filled (from `DEFAULT_KEY_NAMES` if the user omitted them).
   * `electroEntity` / `electroVersion` are intentionally kept optional —
   * the framework only forwards an `identifiers` option to ElectroDB when
   * the user explicitly supplied one, deferring to ElectroDB's own
   * defaults otherwise.
   */
  keyNames: {
    partitionKey: string;
    sortKey: string;
    electroEntity?: string;
    electroVersion?: string;
  };
  lock: Required<NonNullable<MigrationsConfig['lock']>>;
  guard: Required<NonNullable<MigrationsConfig['guard']>>;
  /**
   * Mirror of the input shape. When defined, `validateConfigInvariants`
   * guarantees both `url` and `apiKey` are non-empty strings — but the type
   * keeps them optional to express that absence is a runtime, not type,
   * error.
   */
  remote: MigrationsConfig['remote'] | undefined;
  migrationStartVersions: NonNullable<MigrationsConfig['migrationStartVersions']>;
  runner: Required<NonNullable<MigrationsConfig['runner']>>;
}
