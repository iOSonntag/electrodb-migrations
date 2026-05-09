import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import type { LockRowSnapshot } from '../lock/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { ItemCounts } from '../runner/count-audit.js';
import type { HistoryRow } from '../runner/history-format.js';
import type { UnlockResult } from '../state-mutations/index.js';
import type { RollbackItemCounts } from '../rollback/audit.js';
import type { GuardStateSnapshot } from '../guard/index.js';

/**
 * Options the user passes to {@link createMigrationsClient}. v0.1 expects
 * the user-supplied DynamoDB client and a fully-resolved config (validated
 * upstream via `defineConfig` + `validateConfigInvariants`).
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

  /**
   * RBK-02 — roll back a migration. The id MUST be the head migration of its
   * entity (per RBK-01 head-only rule); preconditions refuse with
   * EDBRollbackOutOfOrderError otherwise.
   *
   * The strategy default is 'projected'; when 'snapshot' is selected, the `yes`
   * flag controls the interactive confirmation prompt (CLI sets it via the
   * --yes flag). The `io` field is an injection point for testing (production
   * omits it).
   */
  rollback(
    id: string,
    options: {
      strategy: 'projected' | 'snapshot' | 'fill-only' | 'custom';
      yes?: boolean;
      io?: {
        stdin?: NodeJS.ReadableStream;
        stderr?: { write: (s: string) => boolean };
        confirm?: (prompt: string) => Promise<boolean>;
      };
    },
  ): Promise<{ itemCounts: RollbackItemCounts }>;

  /**
   * API-05 — operator-path forced clear. Wraps `forceUnlock` from
   * src/lock/unlock.ts which dispatches the LCK-08 truth table.
   *
   * **`yes` is REQUIRED for the call to proceed.** The signature accepts
   * `yes?: boolean` for ergonomics, but when `yes !== true`, the method
   * REJECTS with `EDBUnlockRequiresConfirmationError`. Rationale: this mirrors
   * the CLI's panic-button refusal — the CLI MUST prompt before proceeding
   * (CLI-05); the programmatic API MUST require explicit `yes: true`
   * acknowledgement that the caller is bypassing the safety prompt. The CLI
   * and programmatic surfaces are intentionally consistent (BLOCKER 2 fix /
   * REQUIREMENTS.md line 188).
   *
   * Returns `{priorState}`; the CLI uses this to surface "the in-progress
   * migration was marked as failed" messaging when priorState was an active
   * state.
   *
   * @throws EDBUnlockRequiresConfirmationError — when args.yes !== true
   */
  forceUnlock(args: { runId: string; yes?: boolean }): Promise<UnlockResult>;

  /**
   * API-05 — read the current lock row for inspection. Used by the unlock
   * CLI's pre-execute pre-render. Returns null if the row doesn't exist
   * (fresh project, never bootstrapped).
   */
  getLockState(): Promise<LockRowSnapshot | null>;

  /**
   * API-05 — snapshot of the guard cache state for operator inspection.
   *
   * Returns the pinned `GuardStateSnapshot` shape from `src/guard/cache.ts`
   * (cacheSize + optional lastReadAt + optional lastReadResult). The CLI's
   * status command (Phase 4) may consume this in a future enhancement; v0.1
   * the method is available but the CLI doesn't yet surface it.
   */
  getGuardState(): Promise<GuardStateSnapshot>;
}
