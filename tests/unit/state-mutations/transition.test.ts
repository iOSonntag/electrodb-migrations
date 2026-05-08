import { describe, expect, it } from 'vitest';
import { transitionToReleaseMode } from '../../../src/state-mutations/transition.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.transitionToReleaseMode (LCK-05)', () => {
  it('emits exactly one transactWrite of 3 items (Pitfall #4 + #7)', async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    expect(stub.writeFn).toHaveBeenCalledTimes(1);
    expect(stub.captured).toHaveLength(3);
  });

  it('item ordering is _migration_state, _migrations, _migration_runs (Pitfall #7)', async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    expect(stub.captured[0]?.kind).toBe('_migration_state');
    expect(stub.captured[1]?.kind).toBe('_migrations');
    expect(stub.captured[2]?.kind).toBe('_migration_runs');
  });

  it("item 0 sets lockState='release', shifts inFlightIds → releaseIds", async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    expect(stub.captured[0]?.set).toMatchObject({ lockState: 'release' });
    expect(stub.captured[0]?.delete).toEqual({ inFlightIds: ['mig-1'] });
    expect(stub.captured[0]?.add).toEqual({ releaseIds: ['mig-1'] });
  });

  it("item 0 ConditionExpression includes lockRunId = :runId AND (lockState='apply' OR 'rollback')", async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-XYZ',
      migId: 'mig-1',
      outcome: 'applied',
    });

    const condition = stub.captured[0]?.whereCondition ?? '';
    expect(condition).toContain('eq(lockRunId,"run-XYZ")');
    expect(condition).toContain('"apply"');
    expect(condition).toContain('"rollback"');
  });

  it("outcome='applied' writes appliedAt + appliedRunId on _migrations", async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    expect(stub.captured[1]?.set).toMatchObject({
      status: 'applied',
      appliedRunId: 'run-1',
    });
    expect(stub.captured[1]?.set).toHaveProperty('appliedAt');
    expect(stub.captured[1]?.set).not.toHaveProperty('revertedAt');
    expect(stub.captured[1]?.set).not.toHaveProperty('revertedRunId');
  });

  it("outcome='reverted' writes revertedAt + revertedRunId on _migrations", async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'reverted',
    });

    expect(stub.captured[1]?.set).toMatchObject({
      status: 'reverted',
      revertedRunId: 'run-1',
    });
    expect(stub.captured[1]?.set).toHaveProperty('revertedAt');
    expect(stub.captured[1]?.set).not.toHaveProperty('appliedAt');
    expect(stub.captured[1]?.set).not.toHaveProperty('appliedRunId');
  });

  it("item 2 sets _migration_runs.status='completed' with completedAt + lastHeartbeatAt", async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    const set = stub.captured[2]?.set ?? {};
    expect(set.status).toBe('completed');
    expect(set).toHaveProperty('completedAt');
    expect(set).toHaveProperty('lastHeartbeatAt');
  });

  it('itemCounts and rollbackStrategy are forwarded onto _migrations when provided', async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'reverted',
      itemCounts: { scanned: 100, migrated: 100, skipped: 0, failed: 0 },
      rollbackStrategy: 'projected',
    });

    expect(stub.captured[1]?.set).toMatchObject({
      itemCounts: { scanned: 100, migrated: 100, skipped: 0, failed: 0 },
      rollbackStrategy: 'projected',
    });
  });

  it('itemCounts and rollbackStrategy are absent when not provided', async () => {
    const stub = makeStubService();
    await transitionToReleaseMode(stub.service as never, {
      runId: 'run-1',
      migId: 'mig-1',
      outcome: 'applied',
    });

    expect(stub.captured[1]?.set).not.toHaveProperty('itemCounts');
    expect(stub.captured[1]?.set).not.toHaveProperty('rollbackStrategy');
  });
});
