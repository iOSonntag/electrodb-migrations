import { describe, expect, it } from 'vitest';
import { heartbeat } from '../../../src/state-mutations/heartbeat.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.heartbeat (Pitfall #5 lockRunId condition)', () => {
  it('emits exactly one _migration_state patch (no transactWrite)', async () => {
    const stub = makeStubService();
    await heartbeat(stub.service as never, { runId: 'run-1' });

    // No transactWrite call — heartbeat is a single-entity patch.
    expect(stub.writeFn).toHaveBeenCalledTimes(0);
    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0]?.kind).toBe('_migration_state');
    expect(stub.captured[0]?.op).toBe('patch');
  });

  it('set updates heartbeatAt and updatedAt (and only those)', async () => {
    const stub = makeStubService();
    await heartbeat(stub.service as never, { runId: 'run-1' });

    const set = stub.captured[0]?.set ?? {};
    expect(Object.keys(set).sort()).toEqual(['heartbeatAt', 'updatedAt']);
    expect(set.heartbeatAt).toEqual(set.updatedAt); // same `now`
  });

  it('ConditionExpression mentions lockRunId equality (Pitfall #5 mitigation)', async () => {
    const stub = makeStubService();
    await heartbeat(stub.service as never, { runId: 'run-XYZ' });

    const condition = stub.captured[0]?.whereCondition ?? '';
    expect(condition).toContain('eq(lockRunId,"run-XYZ")');
  });

  it('ConditionExpression admits the four active states (apply/rollback/finalize/dying)', async () => {
    const stub = makeStubService();
    await heartbeat(stub.service as never, { runId: 'run-1' });

    const condition = stub.captured[0]?.whereCondition ?? '';
    expect(condition).toContain('"apply"');
    expect(condition).toContain('"rollback"');
    expect(condition).toContain('"finalize"');
    expect(condition).toContain('"dying"');
  });

  it('ConditionalCheckFailedException propagates verbatim (the heartbeat scheduler counts it toward LCK-10)', async () => {
    const stub = makeStubService();
    // Inject a failure on the next .go() call by overriding the entity's
    // returned chain. We'll trip it by re-stubbing migrationState.patch.
    const originalPatch = (stub.service.migrationState as { patch: unknown }).patch;
    void originalPatch;
    const ccf = Object.assign(new Error('Conditional check failed'), {
      name: 'ConditionalCheckFailedException',
    });
    (stub.service.migrationState as { patch: (id: unknown) => unknown }).patch = () => ({
      set: () => ({
        where: () => ({
          go: async () => {
            throw ccf;
          },
        }),
      }),
    });

    await expect(heartbeat(stub.service as never, { runId: 'run-1' })).rejects.toBe(ccf);
  });
});
