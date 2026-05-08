import { AsyncLocalStorage } from 'node:async_hooks';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ResolvedConfig } from '../config/index.js';
import { EDBMigrationInProgressError } from '../errors/index.js';
import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { readLockRow } from '../lock/index.js';
import { type LockStateCache, type LockStateValue, createLockStateCache } from './cache.js';
import { isReadCommand } from './classify.js';
import { GATING_LOCK_STATES } from './lock-state-set.js';

/**
 * AsyncLocalStorage bypass flag for the guard middleware.
 *
 * **Purpose — T-04-11-03 (runner self-gating prevention):**
 *
 * Because `DynamoDBDocumentClient` shares its `middlewareStack` with the
 * underlying `DynamoDBClient` (see SDK constructor source), adding guard
 * middleware to one client affects ALL clients wrapping the same raw client.
 * This means the runner's own DDB calls (lock-row reads, v1 scans, v2 writes,
 * etc.) would be intercepted by the guard middleware — causing the runner to
 * gate ITSELF when the lock is in `apply` state.
 *
 * The `AsyncLocalStorage` bypass: any async operation that should bypass the
 * guard runs inside `guardBypassStorage.run(true, callback)`. The middleware
 * checks `guardBypassStorage.getStore()` and passes through without guard logic
 * when the flag is `true`.
 *
 * **Isolation guarantee:** `AsyncLocalStorage` is async-context-scoped. Concurrent
 * app-traffic async contexts do NOT inherit the runner's bypass flag — each
 * parallel app write is checked independently.
 *
 * **Exported as `runUnguarded`** so `create-migrations-client.ts` can wrap all
 * runner operations (apply, finalize, etc.) in the bypass context.
 */
const guardBypassStorage = new AsyncLocalStorage<true>();

/**
 * Run `fn` inside the guard bypass context.
 *
 * Any DDB call from within `fn` (including nested async calls on the same
 * async context) bypasses the guard middleware. App-traffic calls on OTHER
 * async contexts remain guarded.
 *
 * Use this for all internal runner operations (applyBatch, finalizeFlow, etc.)
 * when the runner's DDB client shares a middleware stack with the guard client.
 */
export function runUnguarded<T>(fn: () => Promise<T>): Promise<T> {
  return guardBypassStorage.run(true, fn);
}

export interface WrapClientArgs {
  /** The user-supplied DDB client (raw or DocumentClient). Mutated in place. */
  client: DynamoDBClient | DynamoDBDocumentClient;
  /** Resolved config — `guard.cacheTtlMs` and `guard.blockMode` are consumed. */
  config: ResolvedConfig;
  /** Service bundle wired against an UNGUARDED inner client; used to read the lock row. */
  internalService: MigrationsServiceBundle;
}

/**
 * Wrap a `DynamoDBClient` or `DynamoDBDocumentClient` with the migration guard
 * middleware (GRD-01..07). Returns the SAME client (mutated in place).
 *
 * **Pitfall #3** — middleware MUST be registered on `client.middlewareStack`,
 * NEVER on `command.middlewareStack` ([aws-sdk-js-v3#3095]: `lib-dynamodb`
 * silently drops command-level middleware). Client-level works for both
 * `DynamoDBClient` and `DynamoDBDocumentClient`.
 *
 * **Step `'initialize'`** — runs before serialization, so blocked calls cost
 * zero wire activity.
 *
 * **Behavior:** `blockMode: 'writes-only'` + read command → pass through (no
 * lock read); `lockState` in `GATING_LOCK_STATES` → throw
 * `EDBMigrationInProgressError`; `'free'`/`'finalize'` → `next(args)`;
 * `cache.get()` rejection → fail closed (Pitfall #1 / GRD-06).
 *
 * **Decision A7** (`03-WAVE0-NOTES.md`): `'finalize'` is intentionally NOT in
 * `GATING_LOCK_STATES` — see `lock-state-set.ts` JSDoc.
 */
export function wrapClient(args: WrapClientArgs): DynamoDBClient | DynamoDBDocumentClient {
  // The cache wraps `readLockRow` — the single canonical strongly-consistent
  // reader from Plan 04. The mapping `LockRowSnapshot → LockStateValue`
  // surfaces just the two fields the middleware needs (`value`, `runId`).
  // A null row (fresh project, never bootstrapped) is treated as `'free'`.
  const cache: LockStateCache = createLockStateCache({
    cacheTtlMs: args.config.guard.cacheTtlMs,
    // Run readLockRow inside the bypass context so the guard middleware passes
    // through the lock-row read without recursing into itself (T-04-11-03).
    fetchLockState: async () => {
      const row = await guardBypassStorage.run(true, () => readLockRow(args.internalService));
      if (!row) return { value: 'free' };
      const out: LockStateValue = { value: row.lockState };
      if (row.lockRunId !== undefined) out.runId = row.lockRunId;
      return out;
    },
  });

  args.client.middlewareStack.add(
    (next, context) => async (rawArgs) => {
      // Bypass: the guard's own fetchLockState uses guardBypassStorage.run(true, …)
      // to mark its internal DDB call so this middleware passes through without
      // recursing. Concurrent guarded calls from app code do NOT inherit this flag.
      if (guardBypassStorage.getStore() === true) {
        return next(rawArgs);
      }
      const commandName = (context as { commandName?: string }).commandName;
      // GRD-05: `blockMode: 'writes-only'` lets reads through without a lock check.
      if (args.config.guard.blockMode === 'writes-only' && isReadCommand(commandName)) {
        return next(rawArgs);
      }
      // GRD-06 fail closed: cache.get() throws EDBMigrationInProgressError on read failure.
      const lockState = await cache.get();
      if (GATING_LOCK_STATES.has(lockState.value)) {
        const details: Record<string, unknown> = { lockState: lockState.value };
        if (lockState.runId !== undefined) details.runId = lockState.runId;
        throw new EDBMigrationInProgressError(`Migration in progress (lockState=${lockState.value}); request rejected.`, details);
      }
      return next(rawArgs);
    },
    {
      step: 'initialize',
      name: 'electrodb-migrations-guard',
    },
  );

  return args.client;
}
