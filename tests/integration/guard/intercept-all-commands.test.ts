/**
 * GRD-01 + Pitfall #3 — wire-level verification that the guard's middleware
 * actually intercepts every concrete command type on BOTH `DynamoDBClient` and
 * `DynamoDBDocumentClient` against real DDB Local.
 *
 * Plan 05's unit suite (`tests/unit/guard/wrap.test.ts`) verifies the middleware
 * closure shape via a fake client. Plan 05 + this test together close the
 * Pitfall #3 / [aws-sdk-js-v3#3095] regression: `lib-dynamodb` silently drops
 * **command-level** middleware, but the guard registers on `client.middlewareStack`
 * — proving the lib-dynamodb path STILL fires every middleware is the integration
 * test's job.
 *
 * Each test case acquires the global lock via `acquireLock` (so the lockState
 * is 'apply' on disk), wraps a DDB client with the guard, and asserts that the
 * concrete command's `send` rejects with `EDB_MIGRATION_IN_PROGRESS`. A single
 * `acquireLock` is shared across the whole describe block — the lock only
 * needs to be in a gating state once for every middleware-interception test
 * to fail-closed. Each test creates its own guarded client to make the
 * middleware registration explicit per test (and to avoid cross-test
 * middleware accumulation on a shared client).
 */

import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand as RawQueryCommand,
  ScanCommand as RawScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../../../src/config/index.js';
import { wrapClient } from '../../../src/guard/index.js';
import { createMigrationsService } from '../../../src/internal-entities/index.js';
import { acquireLock } from '../../../src/lock/index.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

// Minimal ResolvedConfig the guard cares about. We only consume `guard.cacheTtlMs`
// + `guard.blockMode` and `lock.staleThresholdMs` (for `acquireLock`'s stale-cutoff
// math). Other fields are filled with defaults to satisfy the type but never read.
const baseConfig: ResolvedConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: 'local',
  tableName: 'unused-here',
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

describe('GRD-01 + Pitfall #3: middleware fires for every command type on both client kinds', () => {
  const tableName = randomTableName('grd-01');
  const innerClients = makeDdbLocalClient(); // for the internal service (unguarded)
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(innerClients.raw, tableName);
    // Bootstrap the lock row at lockState='free' (mimics what `init` does in
    // production). ElectroDB's `patch()` adds `attribute_exists(pk) AND
    // attribute_exists(sk)` to its ConditionExpression, so `acquireLock`
    // requires the row to already exist — see clauses.js patch action lines
    // 621-624. Without this seed, `acquire` fails with ConditionalCheckFailed.
    const innerService = createMigrationsService(innerClients.doc, tableName);
    await innerService.migrationState
      .put({
        id: 'state',
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        lockState: 'free',
      })
      .go();
    // Put the table into 'apply' so every command-type test fails closed.
    await acquireLock(innerService, baseConfig, { mode: 'apply', migId: 'mig-grd', runId: 'r-grd', holder: 'h' });
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(innerClients.raw, tableName);
  });

  it('DocumentClient: PutCommand throws EDBMigrationInProgressError when lockState=apply', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const guarded = makeDdbLocalClient();
    const innerService = createMigrationsService(innerClients.doc, tableName);
    const wrapped = wrapClient({ client: guarded.doc, config: baseConfig, internalService: innerService }) as typeof guarded.doc;
    await expect(wrapped.send(new PutCommand({ TableName: tableName, Item: { pk: 'user#1', sk: 'profile', name: 'A' } }))).rejects.toMatchObject({
      code: 'EDB_MIGRATION_IN_PROGRESS',
    });
  }, 30_000);

  it('Raw DynamoDBClient: PutItemCommand throws EDBMigrationInProgressError when lockState=apply', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const guarded = makeDdbLocalClient();
    const innerService = createMigrationsService(innerClients.doc, tableName);
    const wrapped = wrapClient({ client: guarded.raw, config: baseConfig, internalService: innerService }) as typeof guarded.raw;
    await expect(
      wrapped.send(
        new PutItemCommand({
          TableName: tableName,
          Item: { pk: { S: 'user#2' }, sk: { S: 'profile' }, name: { S: 'B' } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'EDB_MIGRATION_IN_PROGRESS' });
  }, 30_000);

  it.each([
    [
      'UpdateCommand',
      () =>
        new UpdateCommand({
          TableName: 'unused',
          Key: { pk: 'k', sk: 's' },
          UpdateExpression: 'SET #a = :v',
          ExpressionAttributeNames: { '#a': 'a' },
          ExpressionAttributeValues: { ':v': 1 },
        }),
    ],
    ['DeleteCommand', () => new DeleteCommand({ TableName: 'unused', Key: { pk: 'k', sk: 's' } })],
    [
      'BatchWriteCommand',
      () =>
        new BatchWriteCommand({
          RequestItems: { unused: [{ PutRequest: { Item: { pk: 'a', sk: 'b' } } }] },
        }),
    ],
    [
      'TransactWriteCommand',
      () =>
        new TransactWriteCommand({
          TransactItems: [{ Put: { TableName: 'unused', Item: { pk: 'a', sk: 'b' } } }],
        }),
    ],
    ['GetCommand', () => new GetCommand({ TableName: 'unused', Key: { pk: 'a', sk: 'b' } })],
    ['QueryCommand', () => new QueryCommand({ TableName: 'unused', KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'a' } })],
    ['ScanCommand', () => new ScanCommand({ TableName: 'unused' })],
  ] as const)(
    'DocumentClient %s throws EDBMigrationInProgressError when lockState=apply',
    async (_name, makeCmd) => {
      if (!alive) {
        console.warn(skipMessage());
        return;
      }
      const guarded = makeDdbLocalClient();
      const innerService = createMigrationsService(innerClients.doc, tableName);
      const wrapped = wrapClient({ client: guarded.doc, config: baseConfig, internalService: innerService }) as typeof guarded.doc;
      // The middleware fires at step `'initialize'` BEFORE serialization, so the
      // throw happens regardless of whether the command's TableName/Key would
      // even be valid against the test table — that's the whole point of
      // intercept-all-commands.
      // biome-ignore lint/suspicious/noExplicitAny: send() overloads are union-typed; runtime accepts any DocumentClient command
      await expect(wrapped.send(makeCmd() as any)).rejects.toMatchObject({ code: 'EDB_MIGRATION_IN_PROGRESS' });
    },
    30_000,
  );

  it.each([
    [
      'UpdateItemCommand',
      () =>
        new UpdateItemCommand({
          TableName: 'unused',
          Key: { pk: { S: 'k' }, sk: { S: 's' } },
          UpdateExpression: 'SET #a = :v',
          ExpressionAttributeNames: { '#a': 'a' },
          ExpressionAttributeValues: { ':v': { N: '1' } },
        }),
    ],
    ['DeleteItemCommand', () => new DeleteItemCommand({ TableName: 'unused', Key: { pk: { S: 'k' }, sk: { S: 's' } } })],
    [
      'BatchWriteItemCommand',
      () =>
        new BatchWriteItemCommand({
          RequestItems: { unused: [{ PutRequest: { Item: { pk: { S: 'a' }, sk: { S: 'b' } } } }] },
        }),
    ],
    [
      'TransactWriteItemsCommand',
      () =>
        new TransactWriteItemsCommand({
          TransactItems: [{ Put: { TableName: 'unused', Item: { pk: { S: 'a' }, sk: { S: 'b' } } } }],
        }),
    ],
    ['GetItemCommand', () => new GetItemCommand({ TableName: 'unused', Key: { pk: { S: 'a' }, sk: { S: 'b' } } })],
    ['QueryCommand (raw)', () => new RawQueryCommand({ TableName: 'unused', KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: 'a' } } })],
    ['ScanCommand (raw)', () => new RawScanCommand({ TableName: 'unused' })],
  ] as const)(
    'Raw DynamoDBClient %s throws EDBMigrationInProgressError when lockState=apply',
    async (_name, makeCmd) => {
      if (!alive) {
        console.warn(skipMessage());
        return;
      }
      const guarded = makeDdbLocalClient();
      const innerService = createMigrationsService(innerClients.doc, tableName);
      const wrapped = wrapClient({ client: guarded.raw, config: baseConfig, internalService: innerService }) as typeof guarded.raw;
      // biome-ignore lint/suspicious/noExplicitAny: send() overloads are union-typed; runtime accepts any raw command
      await expect(wrapped.send(makeCmd() as any)).rejects.toMatchObject({ code: 'EDB_MIGRATION_IN_PROGRESS' });
    },
    30_000,
  );
});
