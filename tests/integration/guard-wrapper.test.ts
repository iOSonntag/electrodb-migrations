import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Entity } from 'electrodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationsClient } from '../../src/core/client.js';
import { bootstrapStateRow } from '../../src/core/lock.js';
import {
  MIGRATION_STATE_ID,
  createMigrationStateEntity,
} from '../../src/entities/migration-state.js';
import { createMigrationsEntity } from '../../src/entities/migrations.js';
import { MigrationInProgressError } from '../../src/errors.js';
import { wrapClientWithMigrationGuard } from '../../src/guard/wrap-client.js';
import { sleep } from '../../src/utils/sleep.js';
import { resetTable } from './helpers/reset-table.js';

const TABLE = 'guard-wrapper-test-table';

const DDB_CONFIG = {
  endpoint: 'http://localhost:8000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
};

// Per-test fresh clients so middleware state doesn't leak between cases.
const newRaw = () => new DynamoDBClient(DDB_CONFIG);

const newUserEntity = (client: DynamoDBDocumentClient) =>
  new Entity(
    {
      model: { entity: 'GuardUser', version: '1', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
    { client, table: TABLE },
  );

const plantLock = async (docClient: DynamoDBDocumentClient, refId: string, heldBy: string) => {
  const stateEntity = createMigrationStateEntity(docClient, TABLE);
  await bootstrapStateRow(stateEntity);
  const now = new Date().toISOString();
  await stateEntity
    .update({ id: MIGRATION_STATE_ID })
    .set({
      lockHolder: heldBy,
      lockRefId: refId,
      lockOperation: 'apply',
      lockMigrationId: 'm-attacker',
      lockAcquiredAt: now,
      heartbeatAt: now,
      updatedAt: now,
    })
    .go();
};

const plantFailed = async (docClient: DynamoDBDocumentClient, id: string) => {
  const migrationsEntity = createMigrationsEntity(docClient, TABLE);
  await migrationsEntity
    .put({
      id,
      status: 'failed',
      fromVersion: '1',
      toVersion: '2',
      entityName: 'User',
      fingerprint: 'sha-x',
      error: 'boom',
    })
    .go();
  const stateEntity = createMigrationStateEntity(docClient, TABLE);
  await bootstrapStateRow(stateEntity);
  await stateEntity
    .update({ id: MIGRATION_STATE_ID })
    .add({ failedIds: [id] })
    .set({ updatedAt: new Date().toISOString() })
    .go();
};

// ElectroDB's executeOperation catches any error thrown inside a DDB call and
// wraps it as `ElectroError` with our error as `.cause`. So the guard's
// MigrationInProgressError surfaces *as cause*, not as the top-level error.
// This helper unwraps and asserts.
const expectGuardThrows = async (p: Promise<unknown>): Promise<MigrationInProgressError> => {
  try {
    await p;
  } catch (err) {
    // biome-ignore lint/suspicious/noExplicitAny: walking cause chain
    let cur: any = err;
    while (cur) {
      if (cur instanceof MigrationInProgressError) return cur;
      cur = cur.cause;
    }
    throw new Error(
      `Expected a MigrationInProgressError in the cause chain. Top error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  throw new Error('Expected the call to throw, but it resolved');
};

const plantDeploymentBlock = async (docClient: DynamoDBDocumentClient, id: string) => {
  const stateEntity = createMigrationStateEntity(docClient, TABLE);
  await bootstrapStateRow(stateEntity);
  await stateEntity
    .update({ id: MIGRATION_STATE_ID })
    .add({ deploymentBlockedIds: [id] })
    .set({ updatedAt: new Date().toISOString() })
    .go();
};

beforeEach(async () => {
  await resetTable(newRaw(), TABLE);
});

describe('wrapClientWithMigrationGuard — happy path', () => {
  it('passes calls through when nothing is blocking', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });

    const User = newUserEntity(guarded);
    await User.put({ id: 'u1', name: 'Alice' }).go();
    const got = await User.get({ id: 'u1' }).go();
    expect(got.data?.name).toBe('Alice');
  });

  it('accepts a DynamoDBDocumentClient as input as well', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    const guarded = wrapClientWithMigrationGuard({
      client: docClient,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });

    const User = newUserEntity(guarded);
    await User.put({ id: 'u1', name: 'Alice' }).go();
    expect((await User.get({ id: 'u1' }).go()).data?.name).toBe('Alice');
  });
});

describe('wrapClientWithMigrationGuard — blocking', () => {
  it('throws MigrationInProgressError on reads when a lock is held (default mode=all)', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantLock(docClient, 'r-attacker', 'attacker');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });

    const User = newUserEntity(guarded);
    await expectGuardThrows(User.get({ id: 'u1' }).go());
  });

  it('throws on writes when a lock is held', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantLock(docClient, 'r1', 'attacker');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });

    const User = newUserEntity(guarded);
    await expectGuardThrows(User.put({ id: 'u1', name: 'Alice' }).go());
  });

  it('blockMode=writes-only lets reads through but blocks writes', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    // Pre-seed a record (with an UNGUARDED entity so the put succeeds).
    const Unguarded = newUserEntity(docClient);
    await Unguarded.put({ id: 'u1', name: 'Alice' }).go();

    await plantLock(docClient, 'r1', 'attacker');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
      blockMode: 'writes-only',
    });
    const User = newUserEntity(guarded);

    // Reads pass through.
    const got = await User.get({ id: 'u1' }).go();
    expect(got.data?.name).toBe('Alice');

    // Writes still throw (wrapped by ElectroDB).
    await expectGuardThrows(User.put({ id: 'u2', name: 'Bob' }).go());
  });

  it('throws with reasons including failed-migration when a row has status=failed', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantFailed(docClient, 'mig-broken');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });
    const User = newUserEntity(guarded);

    const e = await expectGuardThrows(User.get({ id: 'u1' }).go());
    expect(e.reasons).toEqual(['failed-migration']);
    expect(e.failedMigrations?.[0]?.id).toBe('mig-broken');
  });

  it('throws with reasons including deployment-block for an active deployment block', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantDeploymentBlock(docClient, 'mig-blocked');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });
    const User = newUserEntity(guarded);

    const e = await expectGuardThrows(User.get({ id: 'u1' }).go());
    expect(e.reasons).toEqual(['deployment-block']);
    expect(e.deploymentBlockedIds).toEqual(['mig-blocked']);
    expect(e.isReason('deployment-block')).toBe(true);
  });

  it('reports all three reasons when lock + failed + deployment-block are present', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantLock(docClient, 'r1', 'attacker');
    await plantFailed(docClient, 'mig-broken');
    await plantDeploymentBlock(docClient, 'mig-blocked');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });
    const User = newUserEntity(guarded);

    const e = await expectGuardThrows(User.get({ id: 'u1' }).go());
    expect(e.reasons).toContain('locked');
    expect(e.reasons).toContain('failed-migration');
    expect(e.reasons).toContain('deployment-block');
  });
});

describe('wrapClientWithMigrationGuard — caching', () => {
  it('serves a stale guard state until the TTL elapses', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 200,
    });
    const User = newUserEntity(guarded);

    // Initial state: not blocked. First call populates the cache.
    await User.put({ id: 'u1', name: 'Alice' }).go();

    // Plant a lock AFTER the cache is warm.
    await plantLock(docClient, 'r1', 'attacker');

    // Within TTL, the cache still says "not blocked" — call passes.
    await expect(User.get({ id: 'u1' }).go()).resolves.toBeDefined();

    // After TTL expiry, the next call refreshes and sees the lock.
    await sleep(250);
    await expectGuardThrows(User.get({ id: 'u1' }).go());
  });

  it('dedupes concurrent first-fetches into a single getGuardState call', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    const spy = vi.spyOn(migrate, 'getGuardState');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 1000,
    });
    const User = newUserEntity(guarded);

    await Promise.all([
      User.get({ id: 'u1' }).go(),
      User.get({ id: 'u2' }).go(),
      User.get({ id: 'u3' }).go(),
      User.get({ id: 'u4' }).go(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('wrapClientWithMigrationGuard — runner isolation', () => {
  it('migration runner (using the unwrapped client) operates while the wrapped client is blocked', async () => {
    const raw = newRaw();
    const docClient = DynamoDBDocumentClient.from(raw);
    const migrate = createMigrationsClient({
      client: docClient,
      table: TABLE,
      staleThresholdMs: 60_000,
      heartbeatMs: 200,
      acquireWaitMs: 50,
    });

    await plantFailed(docClient, 'mig-broken');

    const guarded = wrapClientWithMigrationGuard({
      client: raw,
      migrationsClient: migrate,
      cacheTtlMs: 50,
    });
    const UserGuarded = newUserEntity(guarded);
    await expectGuardThrows(UserGuarded.get({ id: 'u1' }).go());

    // The runner uses the unwrapped client — it can still query the
    // _migrations row, getStatus(), getLockState(), etc.
    const status = await migrate.getStatus({ migrationId: 'mig-broken' });
    expect(status?.status).toBe('failed');
  });
});
