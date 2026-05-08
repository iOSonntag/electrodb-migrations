import { describe, expect, it } from 'vitest';
import { markFailed } from '../../../src/state-mutations/mark-failed.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.markFailed (LCK-10 abort path)', () => {
  it('emits exactly one transactWrite of 2 items', async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-1', cause: new Error('boom') });

    expect(stub.writeFn).toHaveBeenCalledTimes(1);
    expect(stub.captured).toHaveLength(2);
  });

  it('item ordering is _migration_state then _migration_runs (Pitfall #7)', async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-1', cause: new Error('boom') });

    expect(stub.captured[0]?.kind).toBe('_migration_state');
    expect(stub.captured[1]?.kind).toBe('_migration_runs');
  });

  it("item 0 sets lockState='failed' and updates timestamps", async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-1', cause: new Error('boom') });

    expect(stub.captured[0]?.set).toMatchObject({ lockState: 'failed' });
    expect(stub.captured[0]?.set).toHaveProperty('heartbeatAt');
    expect(stub.captured[0]?.set).toHaveProperty('updatedAt');
  });

  it('item 0 ConditionExpression includes lockRunId equality', async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-XYZ', cause: new Error('boom') });

    expect(stub.captured[0]?.whereCondition).toContain('eq(lockRunId,"run-XYZ")');
  });

  it("item 1 sets _migration_runs status='failed' with completedAt + lastHeartbeatAt + error map", async () => {
    const stub = makeStubService();
    const cause = new Error('boom');
    await markFailed(stub.service as never, { runId: 'run-1', cause });

    const set = stub.captured[1]?.set ?? {};
    expect(set.status).toBe('failed');
    expect(set).toHaveProperty('completedAt');
    expect(set).toHaveProperty('lastHeartbeatAt');
    expect(set.error).toMatchObject({
      message: 'boom',
    });
  });

  it("error.code is the error's code field if present", async () => {
    const stub = makeStubService();
    const cause = Object.assign(new Error('boom'), { code: 'EDB_TEST' });
    await markFailed(stub.service as never, { runId: 'run-1', cause });

    expect((stub.captured[1]?.set?.error as { code?: string }).code).toBe('EDB_TEST');
  });

  it('error.code falls back to err.name when no .code is set', async () => {
    const stub = makeStubService();
    const cause = Object.assign(new Error('boom'), { name: 'TypeError' });
    await markFailed(stub.service as never, { runId: 'run-1', cause });

    expect((stub.captured[1]?.set?.error as { code?: string }).code).toBe('TypeError');
  });

  it("error.code is 'Unknown' for non-Error causes", async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-1', cause: 'string-thrown' });

    expect(stub.captured[1]?.set?.error as { code?: string; message?: string }).toMatchObject({
      code: 'Unknown',
      message: 'string-thrown',
    });
  });

  it('without migId, item 0 has no failedIds add operation', async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, { runId: 'run-1', cause: new Error('boom') });

    // No `.add({failedIds: ...})` — assertion is that .add was never called
    // OR was called with an empty object.
    const add = stub.captured[0]?.add;
    expect(add === undefined || Object.keys(add).length === 0).toBe(true);
  });

  it('with migId, item 0 appends migId to failedIds', async () => {
    const stub = makeStubService();
    await markFailed(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-XYZ',
      cause: new Error('boom'),
    });

    expect(stub.captured[0]?.add).toEqual({ failedIds: ['mig-XYZ'] });
  });
});
