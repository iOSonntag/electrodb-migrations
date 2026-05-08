import { describe, expect, it } from 'vitest';
import { appendInFlight } from '../../../src/state-mutations/append-in-flight.js';
import { makeStubService } from './_stub-service.js';

describe('state-mutations.appendInFlight', () => {
  it('emits exactly one _migration_state patch (no transactWrite)', async () => {
    const stub = makeStubService();
    await appendInFlight(stub.service as never, { runId: 'run-1', migId: 'mig-1' });

    expect(stub.writeFn).toHaveBeenCalledTimes(0);
    expect(stub.captured).toHaveLength(1);
    expect(stub.captured[0]?.kind).toBe('_migration_state');
    expect(stub.captured[0]?.op).toBe('patch');
  });

  it('adds migId to inFlightIds (set add)', async () => {
    const stub = makeStubService();
    await appendInFlight(stub.service as never, { runId: 'run-1', migId: 'mig-XYZ' });

    expect(stub.captured[0]?.add).toEqual({ inFlightIds: ['mig-XYZ'] });
  });

  it('updates lockMigrationId and updatedAt', async () => {
    const stub = makeStubService();
    await appendInFlight(stub.service as never, { runId: 'run-1', migId: 'mig-XYZ' });

    expect(stub.captured[0]?.set).toMatchObject({ lockMigrationId: 'mig-XYZ' });
    expect(stub.captured[0]?.set).toHaveProperty('updatedAt');
  });

  it('ConditionExpression includes lockRunId equality (defends against operator unlock racing the loop)', async () => {
    const stub = makeStubService();
    await appendInFlight(stub.service as never, { runId: 'run-XYZ', migId: 'mig-1' });

    expect(stub.captured[0]?.whereCondition).toContain('eq(lockRunId,"run-XYZ")');
  });
});
