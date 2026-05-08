/**
 * FIN-01/03 — finalize deletes v1 records under maintenance-mode lock; marks
 * _migrations.status='finalized'; clears the lock back to 'free'.
 *
 * With the B-01 fixture (User-add-status), v1 and v2 produce PHYSICALLY
 * DISTINCT rows. After apply: 100 v1 rows + 100 v2 rows. After finalize: 0 v1
 * rows + 100 v2 rows (v2 untouched). This test asserts BOTH conditions —
 * proving finalize deletes ONLY v1, not the entire entity-keyed range.
 * See tests/_helpers/sample-migrations/User-add-status/README.md for the
 * fixture's deliberate key-shape choice.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationsClient } from '../../../src/client/index.js';
import { readLockRow } from '../../../src/lock/index.js';
import { isDdbLocalReachable, skipMessage } from '../_helpers/index.js';
import { type ApplyTestTableSetup, setupApplyTestTable } from './_helpers.js';

/** Fast config for integration tests — short acquireWaitMs so tests run quickly. */
const testConfig = {
  entities: ['src/database/entities'],
  migrations: 'src/database/migrations',
  region: undefined,
  tableName: undefined,
  keyNames: { partitionKey: 'pk', sortKey: 'sk' },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 500 },
  guard: { cacheTtlMs: 100, blockMode: 'all' as const },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
} as const;

describe('FIN-01/03: finalize end-to-end — B-01 fixture proves v1-only deletion', () => {
  let alive = false;
  let setup: ApplyTestTableSetup;

  beforeEach(async () => {
    alive = await isDdbLocalReachable();
    if (alive) {
      setup = await setupApplyTestTable({ recordCount: 100 });
    }
  }, 40_000);

  afterEach(async () => {
    if (alive && setup) await setup.cleanup();
  });

  it('FIN-01/03: finalize deletes v1 (only); marks finalized; clears lock; v2 untouched', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const client = createMigrationsClient({
      config: testConfig,
      client: setup.doc,
      tableName: setup.tableName,
      migrations: [setup.migration],
    });

    // Step 1: apply.
    await client.apply();

    // Pre-finalize: 100 v1 + 100 v2.
    const beforeV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: Record<string, unknown>[] };
    const beforeV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: Record<string, unknown>[] };
    expect(beforeV1.data.length).toBe(100);
    expect(beforeV2.data.length).toBe(100);

    // Step 2: release (clears release-mode lock back to free).
    const releaseResult = await client.release();
    expect(releaseResult.cleared).toBe(true);
    expect((await readLockRow(setup.service))?.lockState).toBe('free');

    // Step 3: finalize.
    const finResult = await client.finalize(setup.migration.id);
    expect(finResult.finalized).toHaveLength(1);
    expect(finResult.finalized[0]!.itemCounts.scanned).toBe(100);
    // count-audit "migrated" slot is reused as "deleted" (option a — see finalizeFlow JSDoc).
    expect(finResult.finalized[0]!.itemCounts.migrated).toBe(100);

    // Lock is back to 'free'.
    const lock = await readLockRow(setup.service);
    expect(lock?.lockState).toBe('free');

    // _migrations row is 'finalized' with ISO-8601 finalizedAt.
    const migRow = (await setup.service.migrations.get({ id: setup.migration.id }).go()) as {
      data: { status: string; finalizedAt?: string } | null;
    };
    expect(migRow.data?.status).toBe('finalized');
    expect(migRow.data?.finalizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601

    // **B-01 fixture proves v1-only deletion:**
    // After finalize: v1 rows GONE (the finalize loop scanned them and deleted),
    // v2 rows REMAIN (v2 has a distinct SK byte path — finalize's v1 entity scan
    // doesn't see them). See README.md in the User-add-status fixture directory.
    const afterV1 = (await setup.v1Entity.scan.go({ pages: 'all' })) as { data: Record<string, unknown>[] };
    const afterV2 = (await setup.v2Entity.scan.go({ pages: 'all' })) as { data: Record<string, unknown>[] };
    expect(afterV1.data.length).toBe(0);   // all v1 deleted
    expect(afterV2.data.length).toBe(100); // v2 untouched (B-01 invariant)
  }, 90_000);
});
