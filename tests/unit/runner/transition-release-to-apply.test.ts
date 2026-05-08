import { describe, expect, it } from 'vitest';
import { transitionReleaseToApply } from '../../../src/runner/transition-release-to-apply.js';
import { makeStubService } from '../state-mutations/_stub-service.js';

describe('runner.transitionReleaseToApply', () => {
  it('captures exactly one _migration_state patch (no transactWrite)', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0]).toMatchObject({ kind: '_migration_state', op: 'patch' });
  });

  it('set fields are exact: lockState, heartbeatAt, updatedAt', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.captured[0]?.set).toEqual({
      lockState: 'apply',
      heartbeatAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  it('heartbeatAt equals updatedAt (single `now` timestamp)', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.captured[0]?.set?.heartbeatAt).toBe(stub.captured[0]?.set?.updatedAt);
  });

  it('where condition contains both lockRunId and lockState equality clauses', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.captured[0]?.whereCondition).toContain('eq(lockRunId,"r1")');
    expect(stub.captured[0]?.whereCondition).toContain('eq(lockState,"release")');
  });

  it('no add/delete/remove — standalone set patch only', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.captured[0]?.add).toBeUndefined();
    expect(stub.captured[0]?.delete).toBeUndefined();
    expect(stub.captured[0]?.remove).toBeUndefined();
  });

  it('does not call transactWrite (single-entity patch only)', async () => {
    const stub = makeStubService();
    await transitionReleaseToApply(stub.service as never, { runId: 'r1', migId: 'm2' });

    expect(stub.writeFn).not.toHaveBeenCalled();
  });
});
