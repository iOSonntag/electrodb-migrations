/**
 * DynamoDB Local lifecycle helpers shared by every integration test.
 *
 * Each integration test creates a uniquely-named ephemeral table in `beforeAll`
 * (so concurrent test files cannot collide) and deletes it in `afterAll`. The
 * pattern matches RESEARCH §"Open Decision 4 — DynamoDB Local lifecycle":
 * `-sharedDb` is set on the container so credentials/region don't matter; per-test
 * tables are the isolation boundary.
 *
 * `seedLockRow` is the Wave 0 minimal seeding utility — it writes a raw item under
 * the fixed key `pk='_migration_state' / sk='state'` so spike tests can prove the
 * eventual-consistency simulator works without bringing up the full ElectroDB
 * Service. Once Plan 02 lands the Service helper (`tests/integration/_helpers/service.ts`)
 * tests should prefer that over the raw seed.
 */

import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, type DynamoDBClient as RawDynamoDBClient, waitUntilTableExists, waitUntilTableNotExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export const DDB_LOCAL_ENDPOINT = 'http://localhost:8000';

export interface DdbLocalClients {
  raw: RawDynamoDBClient;
  doc: DynamoDBDocumentClient;
}

export const makeDdbLocalClient = (): DdbLocalClients => {
  const raw = new DynamoDBClient({
    endpoint: DDB_LOCAL_ENDPOINT,
    region: 'local',
    credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' },
  });
  const doc = DynamoDBDocumentClient.from(raw);
  return { raw, doc };
};

export const randomTableName = (prefix = 'edb-mig-test'): string => {
  return `${prefix}-${randomUUID()}`;
};

export interface CreateTestTableKeys {
  pk?: string;
  sk?: string;
}

export const createTestTable = async (client: RawDynamoDBClient, tableName: string, keys: CreateTestTableKeys = {}): Promise<void> => {
  const pkField = keys.pk ?? 'pk';
  const skField = keys.sk ?? 'sk';
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: pkField, KeyType: 'HASH' },
        { AttributeName: skField, KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: pkField, AttributeType: 'S' },
        { AttributeName: skField, AttributeType: 'S' },
      ],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
};

export const deleteTestTable = async (client: RawDynamoDBClient, tableName: string): Promise<void> => {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
  await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName: tableName });
};

export type SeedLockState = 'free' | 'apply' | 'rollback' | 'finalize' | 'release' | 'failed' | 'dying';

export interface SeedLockRowState {
  lockState: SeedLockState;
  lockRunId?: string;
  lockHolder?: string;
  lockMigrationId?: string;
  lockAcquiredAt?: string;
  heartbeatAt?: string;
  inFlightIds?: string[];
  failedIds?: string[];
  releaseIds?: string[];
  schemaVersion?: number;
  updatedAt?: string;
}

/**
 * Write a minimal raw `_migration_state` row keyed by `pk='_migration_state' / sk='state'`.
 *
 * Wave 0 spike-only convenience. Plan 02 supersedes this with a Service-driven
 * seed once `createMigrationStateService` lands; once that is available, tests
 * should prefer the Service path so the row layout (composite-key prefixes,
 * `__edb_e__` / `__edb_v__` identifiers) matches what the production state-mutations
 * write at runtime. This helper exists ONLY so Wave 0 can prove the simulator.
 */
export const seedLockRow = async (doc: DynamoDBDocumentClient, tableName: string, state: SeedLockRowState): Promise<void> => {
  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: '_migration_state',
        sk: 'state',
        id: 'state',
        ...state,
      },
    }),
  );
};
