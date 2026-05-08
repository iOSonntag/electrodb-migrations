import { describe, expect, it, vi } from 'vitest';
import type { MigrationsServiceBundle } from '../../../src/internal-entities/index.js';
import { readLockRow } from '../../../src/lock/read-lock-row.js';
import { CONSISTENT_READ } from '../../../src/safety/index.js';

interface MockServiceShape {
  service: MigrationsServiceBundle;
  goSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
}

function mockService(getResult: { data: unknown } | { data: null }): MockServiceShape {
  const goSpy = vi.fn(async () => getResult);
  const getSpy = vi.fn(() => ({ go: goSpy }));
  const service = {
    service: {} as never,
    migrationState: { get: getSpy } as never,
    migrations: {} as never,
    migrationRuns: {} as never,
  } as unknown as MigrationsServiceBundle;
  return { service, goSpy, getSpy };
}

describe('readLockRow (LCK-07 — the only lock-row reader in src/lock and src/guard)', () => {
  it('passes consistent: CONSISTENT_READ to ElectroDB go() (LCK-07)', async () => {
    const { service, goSpy } = mockService({ data: { id: 'state', lockState: 'free', schemaVersion: 1, updatedAt: '2026-05-08T00:00:00.000Z' } });
    await readLockRow(service);
    expect(goSpy).toHaveBeenCalledTimes(1);
    expect(goSpy).toHaveBeenCalledWith(expect.objectContaining({ consistent: CONSISTENT_READ }));
    expect(CONSISTENT_READ).toBe(true);
  });

  it("calls migrationState.get with the canonical sentinel id 'state'", async () => {
    const { service, getSpy } = mockService({ data: null });
    await readLockRow(service);
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith({ id: 'state' });
  });

  it('returns null when ElectroDB returns no data', async () => {
    const { service } = mockService({ data: null });
    const result = await readLockRow(service);
    expect(result).toBeNull();
  });

  it('returns the row data verbatim when present', async () => {
    const row = {
      id: 'state',
      lockState: 'apply' as const,
      lockRunId: 'r-1',
      schemaVersion: 1,
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    const { service } = mockService({ data: row });
    expect(await readLockRow(service)).toEqual(row);
  });
});
