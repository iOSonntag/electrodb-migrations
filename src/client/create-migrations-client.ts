import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { wrapClient } from '../guard/index.js';
import { readLockRow } from '../lock/index.js';
import { createMigrationsService } from '../internal-entities/index.js';
import { applyBatch, finalizeFlow, loadPendingMigrations, type HistoryRow, type RawHistoryRow, type ItemCounts } from '../runner/index.js';
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
  const docClient =
    args.client instanceof DynamoDBDocumentClient
      ? args.client
      : DynamoDBDocumentClient.from(args.client as DynamoDBClient);

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
  // The guarded client uses the SAME underlying docClient but adds middleware
  // that blocks writes (or all ops) when a migration lock is active.
  // The runner uses the UNGUARDED `docClient` via `bundle`.
  const guarded = wrapClient({
    client: docClient,
    config: args.config,
    internalService: bundle,
  }) as DynamoDBDocumentClient;

  const client: MigrationsClient = {
    async apply(callArgs) {
      const runId = randomUUID();
      const pending = await loadPendingMigrations({ config: args.config, service: bundle, cwd });
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
      return { applied: result.applied };
    },

    async finalize(arg) {
      if (typeof arg === 'string') {
        const runId = randomUUID();
        const pending = await loadPendingMigrations({ config: args.config, service: bundle, cwd });
        const target = pending.find((p) => p.id === arg);
        if (!target) {
          throw new Error(`Migration '${arg}' not found in ${args.config.migrations}.`);
        }
        const result = await finalizeFlow({
          service: bundle,
          config: args.config,
          client: docClient,
          tableName,
          migration: target.migration,
          runId,
          holder,
        });
        return { finalized: [{ migId: arg, itemCounts: result.itemCounts }] };
      }

      // {all: true} — CLI-tier loop, one finalize per applied migration.
      const all = (await bundle.migrations.scan.go({ pages: 'all' })) as { data: Array<{ id: string; status: string }> };
      const appliedRows = all.data.filter((r) => r.status === 'applied');
      const finalized: { migId: string; itemCounts: ItemCounts }[] = [];
      for (const row of appliedRows) {
        const runId = randomUUID();
        const pending = await loadPendingMigrations({ config: args.config, service: bundle, cwd });
        const target = pending.find((p) => p.id === row.id);
        if (!target) continue; // disk migration not found — skip (operator alert)
        const result = await finalizeFlow({
          service: bundle,
          config: args.config,
          client: docClient,
          tableName,
          migration: target.migration,
          runId,
          holder,
        });
        finalized.push({ migId: row.id, itemCounts: result.itemCounts });
      }
      return { finalized };
    },

    async release() {
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
        throw new Error('release refused — release-mode lock missing lockRunId (corrupted state).');
      }
      await clear(bundle, { runId: row.lockRunId });
      return { cleared: true };
    },

    async history(filter) {
      const all = (await bundle.migrations.scan.go({ pages: 'all' })) as { data: RawHistoryRow[] };
      const rows: HistoryRow[] = all.data.map((r) => {
        const { reads, ...rest } = r;
        const readsArr = reads === undefined ? undefined : [...reads].sort();
        return { ...rest, ...(readsArr !== undefined ? { reads: readsArr } : {}) } as HistoryRow;
      });
      return filter?.entity !== undefined ? rows.filter((r) => r.entityName === filter.entity) : rows;
    },

    async status() {
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
    },

    guardedClient() {
      return guarded;
    },
  };

  return client;
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
