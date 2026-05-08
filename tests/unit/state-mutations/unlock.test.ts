import { describe, expect, it } from 'vitest';
import { unlock } from '../../../src/state-mutations/unlock.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.unlock (LCK-08 state-aware admin path)', () => {
  it('returns {priorState: "free"} without writing when row is missing', async () => {
    const stub = makeStubService();
    stub.setGetResult({ data: null });

    const res = await unlock(stub.service as never, { runId: 'run-1' });
    expect(res).toEqual({ priorState: 'free' });
    // Only one captured call: the GET. No writes.
    expect(stub.captured.filter((c) => c.op !== 'get')).toHaveLength(0);
  });

  it("returns {priorState: 'free'} without writing when lockState='free'", async () => {
    const stub = makeStubService();
    stub.setGetResult({ data: { lockState: 'free' } });

    const res = await unlock(stub.service as never, { runId: 'run-1' });
    expect(res).toEqual({ priorState: 'free' });
    expect(stub.captured.filter((c) => c.op !== 'get')).toHaveLength(0);
  });

  it('reads with consistent: true (the CONSISTENT_READ named constant)', async () => {
    const stub = makeStubService();
    stub.setGetResult({ data: null });

    await unlock(stub.service as never, { runId: 'run-1' });
    const getCall = stub.captured.find((c) => c.op === 'get');
    expect(getCall?.goOptions).toMatchObject({ consistent: true });
  });

  for (const active of ['apply', 'rollback', 'finalize', 'dying'] as const) {
    it(`for lockState='${active}' dispatches to markFailed (2-item transactWrite)`, async () => {
      const stub = makeStubService();
      stub.setGetResult({
        data: { lockState: active, lockMigrationId: 'mig-XYZ' },
      });

      const res = await unlock(stub.service as never, { runId: 'run-1' });
      expect(res).toEqual({ priorState: active });

      // markFailed → ONE transactWrite of 2 items.
      expect(stub.writeFn).toHaveBeenCalledTimes(1);
      const writes = stub.captured.filter((c) => c.op !== 'get');
      expect(writes).toHaveLength(2);
      expect(writes[0]?.kind).toBe('_migration_state');
      expect(writes[0]?.set).toMatchObject({ lockState: 'failed' });
      // The forwarded migId from the lock row populates failedIds.
      expect(writes[0]?.add).toEqual({ failedIds: ['mig-XYZ'] });
    });
  }

  for (const cleanable of ['release', 'failed'] as const) {
    it(`for lockState='${cleanable}' performs a forced clear (single patch, bypasses LCK-09 inFlightIds check)`, async () => {
      const stub = makeStubService();
      stub.setGetResult({ data: { lockState: cleanable } });

      const res = await unlock(stub.service as never, { runId: 'run-XYZ' });
      expect(res).toEqual({ priorState: cleanable });

      // Forced-clear is a single .patch().go() — no transactWrite.
      expect(stub.writeFn).toHaveBeenCalledTimes(0);
      const writes = stub.captured.filter((c) => c.op !== 'get');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.kind).toBe('_migration_state');
      expect(writes[0]?.op).toBe('patch');
      expect(writes[0]?.set).toMatchObject({ lockState: 'free' });
      // ConditionExpression: only lockRunId — no inFlightIds size check.
      expect(writes[0]?.whereCondition).toContain('eq(lockRunId,"run-XYZ")');
      expect(writes[0]?.whereCondition).not.toContain('size(inFlightIds)');
    });
  }
});
