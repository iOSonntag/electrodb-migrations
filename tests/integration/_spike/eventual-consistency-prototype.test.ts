/**
 * Wave 0 spike: confirms that the BLD-04 eventual-consistency simulator's
 * synthesized response shape is accepted by the AWS SDK v3 deserializer.
 *
 * Verifies BOTH paths:
 * - `ConsistentRead` unset → middleware returns the recorded "stale" state
 *   (the bug-finding path the production guard tests will use).
 * - `ConsistentRead: true` → middleware passes through to the real wire send;
 *   the actual on-disk state is returned (the production safety path).
 *
 * If Docker / DDB Local is not reachable, the test logs `skipMessage()` and
 * returns 0 — Wave 0 must not fail the suite for a missing environmental
 * prerequisite.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachEventualConsistencyMiddleware, createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

describe('Wave 0 spike: eventual-consistency simulator', () => {
  const tableName = randomTableName('ec-proto');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('returns recorded stale state on lock-row GetItem when ConsistentRead is unset; passes through when ConsistentRead: true', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }

    const harness = attachEventualConsistencyMiddleware(raw, tableName);

    // Real PUT — stamps lockState='apply' on disk
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { pk: '_migration_state', sk: 'state', lockState: 'apply', lockRunId: 'r-real' },
      }),
    );

    // Record the SIMULATED stale state (lockState='free') and open the stale window
    harness.recordWrite({ pk: '_migration_state', sk: 'state', lockState: 'free' });
    harness.beginStaleWindow(2000);

    // GET without ConsistentRead — should return the SIMULATED stale state
    const stale = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: '_migration_state', sk: 'state' },
      }),
    );
    expect(stale.Item?.lockState).toBe('free');
    expect(harness.staleHits()).toBe(1);

    // GET WITH ConsistentRead: true — bypasses simulator, returns real state
    const fresh = await doc.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: '_migration_state', sk: 'state' },
        ConsistentRead: true,
      }),
    );
    expect(fresh.Item?.lockState).toBe('apply');
    expect(harness.staleHits()).toBe(1);
  }, 15_000);
});
