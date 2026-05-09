import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { wrapClient, runUnguarded } from '../guard/index.js';
import { readLockRow } from '../lock/index.js';
import { createMigrationsService } from '../internal-entities/index.js';
import {
  applyBatch,
  finalizeFlow,
  loadPendingMigrations,
  renderApplySummary,
  type HistoryRow,
  type ItemCounts,
  type PendingMigration,
  type RawHistoryRow,
} from '../runner/index.js';
import type { AnyElectroEntity, Migration } from '../migrations/index.js';
import type { ResolvedConfig } from '../config/index.js';
import { clear } from '../state-mutations/index.js';
import type { CreateMigrationsClientArgs, MigrationsClient } from './types.js';

/**
 * API-01 — programmatic client factory.
 *
 * Wires the user's DynamoDB client to the framework's runner orchestrators.
 * The client is BLOCKING (each method awaits the full lock cycle); Phase 9
 * adds `runInBackground`/`getRunStatus` for the `--remote` path.
 *
 * **Two clients in play:**
 * - `docClient` (the bundle's inner `DynamoDBDocumentClient`) — used by the
 *   runner for v1 scan, v2 write, _migrations / _migration_state /
 *   _migration_runs reads/writes. The runner MUST be unguarded — otherwise
 *   it would gate itself (T-04-11-03 mitigation).
 * - `guardedClient()` — the user-facing wrapped client; gates app traffic
 *   when the lock is in `GATING_LOCK_STATES`. Returned by the `guardedClient()`
 *   method per Assumption A7 (RESEARCH).
 */
export function createMigrationsClient(args: CreateMigrationsClientArgs): MigrationsClient {
  // Step 1: resolve table name. Override > config.tableName(string) > config.tableName(thunk).
  const tableName = resolveTableName(args);

  // Step 2: ensure DocumentClient. Phase 3 service wrapper accepts DocumentClient only.
  // `DynamoDBClient` is the raw SDK client; `DynamoDBDocumentClient` extends it with
  // marshalling. We use `instanceof DynamoDBClient` to detect the raw variant — the
  // `DynamoDBDocumentClient` is also an instance of `DynamoDBClient`, but the user
  // intending a DocumentClient will pass it directly. Use an explicit check on
  // `DynamoDBDocumentClient` to avoid wrapping an already-wrapped client.
  //
  // ISOLATION INVARIANT — guard middleware must NEVER intercept runner/bundle operations.
  //
  // `wrapClient` mutates the client's `middlewareStack` in place. In AWS SDK v3,
  // `DynamoDBDocumentClient` shares the SAME `middlewareStack` object as the underlying
  // raw `DynamoDBClient` (verified: `DynamoDBDocumentClient.from(raw).middlewareStack === raw.middlewareStack`).
  // Adding guard middleware to any `DynamoDBDocumentClient` ALSO adds it to the underlying
  // raw client's stack, which means ALL subsequent commands on that raw client — including
  // the runner bundle's internal scans, patches, and deletes — would also be intercepted.
  // This creates a fail-closed loop: `resolvePendingMigrations` scans `_migrations`, the
  // guard intercepts that scan, tries to read the lock row, and the whole thing deadlocks.
  //
  // Solution: build the internal bundle from a FRESH `DynamoDBClient` constructed from
  // the existing client's `config` object. `new DynamoDBClient(existingConfig)` creates
  // a new instance with an independent `middlewareStack` that is not shared with `args.client`.
  // The guarded path wraps `args.client` (or a fresh doc client from it) directly.
  const userDocClient =
    args.client instanceof DynamoDBDocumentClient
      ? args.client
      : DynamoDBDocumentClient.from(args.client as DynamoDBClient);

  // ISOLATION: Two separate middleware stacks — one for the internal bundle, one for the guard.
  //
  // `DynamoDBDocumentClient` shares the same `middlewareStack` object as the underlying
  // raw `DynamoDBClient`. When `wrapClient` mutates a client's `middlewareStack` in place
  // (adding the guard middleware), that mutation propagates to ALL other `DynamoDBDocumentClient`
  // instances and the raw `DynamoDBClient` that share the same stack — including the test's
  // `setup.raw` used for table lifecycle operations. Cleanup calls (DeleteTable) would then
  // be blocked by the guard when the lock is in a gating state.
  //
  // Solution:
  //   1. For the BUNDLE (internal): clone the middlewareStack so the bundle uses a copy
  //      that is not shared with the user's client. The guard will never affect it.
  //   2. For the GUARD (user-facing): also clone the stack, add the guard, and use this
  //      as the guarded client. The original user-supplied client (`args.client`) is
  //      NOT mutated — its stack is unchanged.
  //
  // `middlewareStack.clone()` is a smithy-client internal (not in TS types) that returns
  // a new stack object with the same handlers. This is the load-bearing isolation
  // primitive for the runUnguarded bypass mechanism — if it ever disappears or its
  // shape changes, the runner could re-gate itself on its own lock (T-04-11-03 regression).
  type CloneableStack = { clone: () => typeof userDocClient.middlewareStack };
  const userStack = userDocClient.middlewareStack as unknown as Partial<CloneableStack>;
  if (typeof userStack.clone !== 'function') {
    // Fail closed with a precise diagnostic rather than producing a TypeError deep
    // inside a guarded write later. If a future AWS SDK ever drops or renames
    // `middlewareStack.clone`, surfacing this here gives operators an actionable
    // signal: pin to a known-compatible @aws-sdk/client-dynamodb version.
    throw new Error(
      'createMigrationsClient: client.middlewareStack.clone is not available. ' +
        'This is a smithy-client internal the framework relies on to keep the ' +
        'runner bundle isolated from guard middleware. Pin @aws-sdk/client-dynamodb ' +
        'to a version where middlewareStack.clone() exists, or open an issue.',
    );
  }
  const cloneStack = (): typeof userDocClient.middlewareStack =>
    (userDocClient.middlewareStack as unknown as CloneableStack).clone();

  // Bundle client: uses a cloned stack (pre-guard snapshot).
  const bundleDocClient = DynamoDBDocumentClient.from(userDocClient);
  bundleDocClient.middlewareStack = cloneStack();
  const docClient = bundleDocClient;

  // Guard client: a separate DocumentClient instance with its OWN cloned stack.
  // Wrapping this instance does NOT affect userDocClient or bundleDocClient.
  const guardedDocClient = DynamoDBDocumentClient.from(userDocClient);
  guardedDocClient.middlewareStack = cloneStack();

  // Runtime isolation assertion: the three stacks must be three distinct objects.
  // If `clone()` ever returns the same reference (or a shallow alias), guard
  // middleware additions would propagate back into the bundle / user client and
  // re-gate the runner on its own lock. Fail closed if the invariant breaks.
  if (
    bundleDocClient.middlewareStack === userDocClient.middlewareStack ||
    guardedDocClient.middlewareStack === userDocClient.middlewareStack ||
    bundleDocClient.middlewareStack === guardedDocClient.middlewareStack
  ) {
    throw new Error(
      'createMigrationsClient: middlewareStack.clone() returned a non-independent stack. ' +
        'The runner bundle, guard, and user clients must each have an isolated middleware ' +
        'stack — a shared stack would cause the runner to gate itself on its own lock.',
    );
  }

  // Step 3: build internal-entity bundle for the runner.
  const { electroEntity, electroVersion } = args.config.keyNames;
  const internalOptions =
    electroEntity !== undefined || electroVersion !== undefined
      ? {
          identifiers: {
            ...(electroEntity !== undefined ? { entity: electroEntity } : {}),
            ...(electroVersion !== undefined ? { version: electroVersion } : {}),
          },
        }
      : undefined;

  const bundle = internalOptions
    ? createMigrationsService(docClient, tableName, internalOptions)
    : createMigrationsService(docClient, tableName);

  const holder = args.holder ?? `${hostname()}:${process.pid}`;
  const cwd = args.cwd ?? process.cwd();

  // Step 4: build the guarded client for the user's app-time DDB calls.
  //
  // Wraps `guardedDocClient` (a cloned-stack instance) so the guard middleware is
  // ONLY on this instance. `userDocClient`, `docClient`, and `setup.raw` are all
  // unaffected by this wrap operation.
  //
  // NOTE (T-04-11-03): the guard reads the lock row via `readLockRow(bundle)` from
  // inside its own middleware. To avoid infinite recursion through the guard's own
  // wrap, `fetchLockState` runs inside an `AsyncLocalStorage` bypass context (see
  // `wrap.ts` and `runUnguarded`). The runner code path also uses `runUnguarded`
  // around its scan/write loop so it doesn't gate itself on the lock it just acquired.
  const guarded = wrapClient({
    client: guardedDocClient,
    config: args.config,
    internalService: bundle,
  }) as DynamoDBDocumentClient;

  const client: MigrationsClient = {
    async apply(callArgs) {
      return runUnguarded(async () => {
      const runId = randomUUID();
      const startedAt = Date.now();
      const pending = await resolvePendingMigrations(args.migrations, { config: args.config, service: bundle, cwd });
      const result = await applyBatch({
        service: bundle,
        config: args.config,
        client: docClient,
        tableName,
        pending,
        ...(callArgs?.migrationId !== undefined ? { migrationId: callArgs.migrationId } : {}),
        runId,
        holder,
      });

      // RUN-09 — write the apply success summary to stderr so operators see
      // the "Run `electrodb-migrations release`" checklist regardless of
      // whether they invoke via CLI or programmatic client.
      if (result.applied.length > 0) {
        const elapsedMs = Date.now() - startedAt;
        const history = (await bundle.migrations.scan.go({ pages: 'all' } as never)) as {
          data: RawHistoryRow[];
        };
        const entries = result.applied.map((a) => {
          const row = history.data.find((h) => h.id === a.migId);
          return {
            id: a.migId,
            entityName: row?.entityName ?? 'unknown',
            fromVersion: row?.fromVersion ?? '?',
            toVersion: row?.toVersion ?? '?',
            itemCounts: a.itemCounts,
          };
        });
        const summary = renderApplySummary({ migrations: entries, totalElapsedMs: elapsedMs });
        process.stderr.write(summary);
      }

      return { applied: result.applied };
      }); // end runUnguarded
    },

    async finalize(arg) {
      return runUnguarded(async () => {
      if (typeof arg === 'string') {
        const runId = randomUUID();
        // When pre-loaded migrations are provided, look up by id across ALL of them
        // (not just pending ones) — finalize targets applied migrations.
        // When not pre-loaded, resolve from disk (pending list covers newly-applied ones).
        let migrationObj: Migration<AnyElectroEntity, AnyElectroEntity> | undefined;
        if (args.migrations) {
          migrationObj = args.migrations.find((m) => m.id === arg);
        } else {
          const pending = await resolvePendingMigrations(undefined, { config: args.config, service: bundle, cwd });
          migrationObj = pending.find((p) => p.id === arg)?.migration;
        }
        if (!migrationObj) {
          throw new Error(`Migration '${arg}' not found in ${args.config.migrations}.`);
        }
        const result = await finalizeFlow({
          service: bundle,
          config: args.config,
          client: docClient,
          tableName,
          migration: migrationObj,
          runId,
          holder,
        });
        return { finalized: [{ migId: arg, itemCounts: result.itemCounts }] };
      }

      // {all: true} — CLI-tier loop, one finalize per applied migration.
      const all = (await bundle.migrations.scan.go({ pages: 'all' })) as { data: Array<{ id: string; status: string }> };
      const appliedRows = all.data.filter((r) => r.status === 'applied');
      const finalized: { migId: string; itemCounts: ItemCounts }[] = [];
      // Build a lookup of all available migrations (preloaded or from disk).
      const allAvailable = args.migrations
        ? new Map(args.migrations.map((m) => [m.id, m]))
        : null;
      for (const row of appliedRows) {
        const runId = randomUUID();
        let migrationObj: Migration<AnyElectroEntity, AnyElectroEntity> | undefined;
        if (allAvailable) {
          migrationObj = allAvailable.get(row.id);
        } else {
          const pendingList = await resolvePendingMigrations(undefined, { config: args.config, service: bundle, cwd });
          migrationObj = pendingList.find((p) => p.id === row.id)?.migration;
        }
        if (!migrationObj) {
          // README §1 contract: a migration cannot leave the table in a half-migrated
          // state without explicit operator action. Silently skipping an applied
          // migration whose source has vanished violates that — fail closed and
          // hand the operator an actionable remediation.
          const err: Error & { code?: string; remediation?: string } = new Error(
            `finalize --all: migration source for '${row.id}' is not available on disk or in the preloaded migrations array.`,
          );
          err.code = 'EDB_MIGRATION_SOURCE_MISSING';
          err.remediation = `Restore the migration source under '${args.config.migrations}/${row.id}' or pass it via the 'migrations' option, then re-run.`;
          throw err;
        }
        const result = await finalizeFlow({
          service: bundle,
          config: args.config,
          client: docClient,
          tableName,
          migration: migrationObj,
          runId,
          holder,
        });
        finalized.push({ migId: row.id, itemCounts: result.itemCounts });
      }
      return { finalized };
      }); // end runUnguarded
    },

    async release() {
      // runUnguarded: readLockRow and clear use the bundle which shares the guarded
      // middleware stack; bypass is required so they can execute when lock is in release state.
      return runUnguarded(async () => {
        const row = await readLockRow(bundle);
        if (!row || row.lockState === 'free') {
          return { cleared: false, reason: 'no-active-release-lock' };
        }
        if (row.lockState !== 'release') {
          const err: Error & { code?: string; remediation?: string } = new Error(
            `release refused — lock is in '${row.lockState}' state, not 'release'.`,
          );
          err.code = 'EDB_RELEASE_PREMATURE';
          err.remediation = `Wait for the active operation to complete, or run \`unlock --run-id ${row.lockRunId ?? '<unknown>'}\` if the runner is dead.`;
          throw err;
        }
        if (!row.lockRunId) {
          const err: Error & { code?: string; remediation?: string } = new Error(
            'release refused — release-mode lock row exists but lockRunId is missing (corrupted state).',
          );
          err.code = 'EDB_LOCK_CORRUPT';
          err.remediation = 'Inspect with `electrodb-migrations status`. If the lock state is unrecoverable, use `electrodb-migrations unlock --force`.';
          throw err;
        }
        await clear(bundle, { runId: row.lockRunId });
        return { cleared: true };
      });
    },

    async history(filter) {
      // runUnguarded: bundle scan may be called while lock is in a gating state.
      return runUnguarded(async () => {
        const all = (await bundle.migrations.scan.go({ pages: 'all' })) as { data: RawHistoryRow[] };
        const rows: HistoryRow[] = all.data.map((r) => {
          const { reads, ...rest } = r;
          const readsArr = reads === undefined ? undefined : [...reads].sort();
          return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) } as HistoryRow;
        });
        return filter?.entity !== undefined ? rows.filter((r) => r.entityName === filter.entity) : rows;
      });
    },

    async status() {
      // runUnguarded: readLockRow + bundle scan use the shared guarded middleware stack.
      return runUnguarded(async () => {
        const lock = await readLockRow(bundle);
        const all = (await bundle.migrations.scan.go({ pages: 'all' })) as { data: RawHistoryRow[] };
        const recent = all.data
          .map((r): HistoryRow => {
            const { reads, ...rest } = r;
            const readsArr = reads === undefined ? undefined : [...reads].sort();
            return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) } as HistoryRow;
          })
          .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)) // descending by id (newest first)
          .slice(0, 10);
        return { lock, recent };
      });
    },

    guardedClient() {
      return guarded;
    },
  };

  return client;
}

/**
 * Resolve the pending migrations list.
 *
 * When `preloaded` is provided (the `migrations` array from `CreateMigrationsClientArgs`),
 * skip disk discovery and build the `PendingMigration[]` directly from the array by
 * correlating against `_migrations` rows (same pending-filter logic as `loadPendingMigrations`).
 * This supports integration tests and Lambda bundlers where disk discovery is unavailable.
 *
 * When `preloaded` is absent, delegates to `loadPendingMigrations` (disk walk).
 */
async function resolvePendingMigrations(
  preloaded: ReadonlyArray<Migration<AnyElectroEntity, AnyElectroEntity>> | undefined,
  args: { config: ResolvedConfig; service: ReturnType<typeof createMigrationsService>; cwd: string },
): Promise<PendingMigration[]> {
  if (!preloaded || preloaded.length === 0) {
    return loadPendingMigrations(args);
  }

  // Build PendingMigration objects from the pre-loaded array.
  const onDisk: PendingMigration[] = preloaded.map((mig) => {
    const fromVersion = (mig.from as unknown as { model: { version: string } }).model.version;
    const toVersion = (mig.to as unknown as { model: { version: string } }).model.version;
    return {
      id: mig.id,
      entityName: mig.entityName,
      fromVersion,
      toVersion,
      migration: mig,
      path: `(preloaded):${mig.id}`,
    };
  });

  // Correlate against _migrations rows (same filter as loadPendingMigrations).
  const scanResult = (await args.service.migrations.scan.go({ pages: 'all' })) as {
    data: Array<{ id: string; status: string }>;
  };
  const byId = new Map<string, { status: string }>(scanResult.data.map((r) => [r.id, r]));

  const pending = onDisk.filter((m) => {
    const row = byId.get(m.id);
    return !row || row.status === 'pending';
  });

  // Sort ascending by (entityName alphabetic, fromVersion numeric) — same as loadPendingMigrations.
  pending.sort((a, b) => {
    if (a.entityName !== b.entityName) return a.entityName < b.entityName ? -1 : 1;
    return Number.parseInt(a.fromVersion, 10) - Number.parseInt(b.fromVersion, 10);
  });

  return pending;
}

/**
 * Resolve the DynamoDB table name from the client args.
 *
 * Priority: explicit `tableName` arg > `config.tableName` string > `config.tableName` thunk.
 * If none resolves, throws a plain `Error` (W-01 pinned — NOT a typed EDB class).
 */
function resolveTableName(args: CreateMigrationsClientArgs): string {
  if (typeof args.tableName === 'string' && args.tableName.length > 0) {
    return args.tableName;
  }
  const t = args.config.tableName;
  if (typeof t === 'string' && t.length > 0) {
    return t;
  }
  if (typeof t === 'function') {
    const resolved = t();
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  }
  throw new Error(
    'createMigrationsClient: tableName is required (set config.tableName or pass tableName arg).',
  );
}
