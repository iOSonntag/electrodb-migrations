import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { LockRowSnapshot } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { ItemCounts } from '../runner/count-audit.js';
import type { HistoryRow } from '../runner/history-format.js';

/**
 * Options the user passes to {@link createMigrationsClient}. v0.1 expects
 * the user-supplied DynamoDB client and a fully-resolved config (validated
 * upstream via `defineConfig` + `validateConfigInvariants`).
 *
 * Created by Plan 04-11 (createMigrationsClient programmatic API).
 */
export interface CreateMigrationsClientArgs {
  config: ResolvedConfig;
  /** Either a raw `DynamoDBClient` OR an already-wrapped `DynamoDBDocumentClient`. */
  client: DynamoDBClient | DynamoDBDocumentClient;
  /** Override for `config.tableName`. Wins if both supplied. */
  tableName?: string;
  /** Operator/host identifier; defaults to `<os.hostname()>:<process.pid>`. */
  holder?: string;
  /**
   * Working directory used for migration discovery (`config.migrations`
   * resolved relative to this). Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * The user's pre-loaded migrations (programmatic alternative to disk
   * discovery). When provided, the client SKIPS `loadPendingMigrations`'s
   * disk walk and uses this list as the source of truth. Useful for Lambda
   * harness (Phase 9) where bundlers strip the `migrations/` dir.
   */
  migrations?: ReadonlyArray<Migration<AnyElectroEntity, AnyElectroEntity>>;
}

/**
 * v0.1 blocking programmatic API surface (API-02). Phase 5+ adds `rollback`;
 * Phase 9 adds `runInBackground`/`getRunStatus`. The `guardedClient()` method
 * is the user's app-time DDB client.
 *
 * Each method is a Promise — the runner's lock + heartbeat + scan/write
 * lifecycle runs to completion before the Promise resolves (or rejects on
 * any failure). `runId` is generated per-call.
 */
export interface MigrationsClient {
  /**
   * Apply pending migrations end-to-end. With no args, applies all pending.
   * With `{migrationId}`, applies only that migration (must be next pending
   * for its entity per RUN-06). Result: `{applied: [{migId, itemCounts}]}`.
   */
  apply(args?: { migrationId?: string }): Promise<{ applied: ReadonlyArray<{ migId: string; itemCounts: ItemCounts }> }>;
  /**
   * Finalize a single migration (delete v1 records). With `{all: true}`,
   * finalize every `status='applied'` migration in sequence (CLI-tier loop —
   * each migration is its own lock cycle).
   */
  finalize(arg: string | { all: true }): Promise<{ finalized: ReadonlyArray<{ migId: string; itemCounts: ItemCounts }> }>;
  /**
   * Clear the release-mode lock. Idempotent: if no active release-mode lock,
   * returns `{cleared: false, reason: 'no-active-release-lock'}` without throwing.
   */
  release(): Promise<{ cleared: boolean; reason?: 'no-active-release-lock' }>;
  /** Read the full `_migrations` log; optionally filtered by entity. */
  history(filter?: { entity?: string }): Promise<ReadonlyArray<HistoryRow>>;
  /** Read the lock row + recent `_migrations` rows. */
  status(): Promise<{ lock: LockRowSnapshot | null; recent: ReadonlyArray<HistoryRow> }>;
  /**
   * Returns the user-facing GUARDED DDB client (Phase 3 wrap). The user's
   * app code uses this for runtime reads/writes; the framework's runner
   * uses the UNGUARDED client internally.
   */
  guardedClient(): DynamoDBDocumentClient;
}
