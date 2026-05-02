import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ApplyContext } from '../../../src/core/apply-migrations.js';
import { createMigrationsService } from '../../../src/entities/service.js';

// Builds a fresh ApplyContext bound to the given table. Each integration test
// calls this in beforeEach (or per-it) so entities, the Service, and the
// transaction layer are pinned to that test's table.
//
// Defaults match the fast-tests profile: short heartbeat + acquireWait so the
// runner is responsive without slowing the suite down.
export const buildContext = (
  client: DynamoDBDocumentClient,
  table: string,
  overrides?: Partial<Omit<ApplyContext, 'service' | 'migrationsEntity' | 'migrationStateEntity'>>,
): ApplyContext => {
  const { service, migrations, migrationState } = createMigrationsService(client, table);
  return {
    service,
    migrationsEntity: migrations,
    migrationStateEntity: migrationState,
    appliedBy: overrides?.appliedBy ?? 'integration-test:1',
    staleThresholdMs: overrides?.staleThresholdMs ?? 60_000,
    heartbeatMs: overrides?.heartbeatMs ?? 200,
    acquireWaitMs: overrides?.acquireWaitMs ?? 50,
  };
};
