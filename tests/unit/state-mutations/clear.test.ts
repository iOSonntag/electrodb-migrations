import { describe, expect, it } from 'vitest';
import { clear } from '../../../src/state-mutations/clear.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.clear (LCK-09 release-refused-while-inflight)', () => {
  it('emits exactly one transactWrite of 1 item', async () => {
    const stub = makeStubService();
    await clear(stub.service as never, { runId: 'run-1' });

    expect(stub.writeFn).toHaveBeenCalledTimes(1);
    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0]?.kind).toBe('_migration_state');
  });

  it("set transitions lockState to 'free' and updates updatedAt", async () => {
    const stub = makeStubService();
    await clear(stub.service as never, { runId: 'run-1' });

    expect(stub.captured[0]?.set).toMatchObject({ lockState: 'free' });
    expect(stub.captured[0]?.set).toHaveProperty('updatedAt');
  });

  it('removes the lock-holder fields (lockHolder, lockRunId, lockMigrationId, lockAcquiredAt, heartbeatAt)', async () => {
    const stub = makeStubService();
    await clear(stub.service as never, { runId: 'run-1' });

    expect(stub.captured[0]?.remove).toEqual(
      expect.arrayContaining([
        'lockHolder',
        'lockRunId',
        'lockMigrationId',
        'lockAcquiredAt',
        'heartbeatAt',
      ]),
    );
  });

  it("ConditionExpression mentions lockState='release', lockRunId, and inFlightIds emptiness (LCK-09)", async () => {
    const stub = makeStubService();
    await clear(stub.service as never, { runId: 'run-XYZ' });

    const condition = stub.captured[0]?.whereCondition ?? '';
    expect(condition).toContain('eq(lockState,"release")');
    expect(condition).toContain('eq(lockRunId,"run-XYZ")');
    // size(inFlightIds) = 0 — LCK-09. ElectroDB renders this via op.size; in
    // the stub we receive `size(inFlightIds)` as the rendered string.
    expect(condition).toContain('inFlightIds');
  });
});
