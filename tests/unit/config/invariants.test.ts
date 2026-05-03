import { describe, expect, it } from 'vitest';
import { EDBConfigInvariantViolationError, validateConfigInvariants } from '../../../src/config/invariants.js';
import type { ResolvedConfig } from '../../../src/config/types.js';

const baseConfig: ResolvedConfig = {
  entities: ['x'],
  migrations: 'm',
  region: undefined,
  tableName: 't',
  keyNames: {
    partitionKey: 'pk',
    sortKey: 'sk',
    electroEntity: '__edb_e__',
    electroVersion: '__edb_v__',
  },
  lock: { heartbeatMs: 30_000, staleThresholdMs: 14_400_000, acquireWaitMs: 15_000 },
  guard: { cacheTtlMs: 5_000, blockMode: 'all' },
  remote: undefined,
  migrationStartVersions: {},
  runner: { concurrency: 1 },
};

describe('validateConfigInvariants — Pitfall #2 §5.3', () => {
  it('returns silently when cacheTtlMs (5_000) < acquireWaitMs (15_000)', () => {
    expect(() => validateConfigInvariants(baseConfig)).not.toThrow();
  });

  it('throws when cacheTtlMs === acquireWaitMs (strict less-than rule)', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      guard: { ...baseConfig.guard, cacheTtlMs: 15_000 },
    };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('throws when cacheTtlMs > acquireWaitMs', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      guard: { ...baseConfig.guard, cacheTtlMs: 20_000 },
    };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('error message contains both values, headroom, and README §5.3 pointer', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      guard: { ...baseConfig.guard, cacheTtlMs: 20_000 },
      lock: { ...baseConfig.lock, acquireWaitMs: 15_000 },
    };
    try {
      validateConfigInvariants(cfg);
      throw new Error('expected to throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('20000');
      expect(msg).toContain('15000');
      expect(msg).toContain('-5000'); // headroom is negative
      expect(msg).toContain('§5.3');
    }
  });

  it('error.details carries {cacheTtlMs, acquireWaitMs, headroomMs} and is frozen', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      guard: { ...baseConfig.guard, cacheTtlMs: 20_000 },
      lock: { ...baseConfig.lock, acquireWaitMs: 15_000 },
    };
    try {
      validateConfigInvariants(cfg);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as EDBConfigInvariantViolationError;
      expect(err.details).toEqual({
        cacheTtlMs: 20_000,
        acquireWaitMs: 15_000,
        headroomMs: -5_000,
      });
      expect(Object.isFrozen(err.details)).toBe(true);
      expect(err.code).toBe('EDB_CONFIG_INVARIANT_VIOLATION');
    }
  });
});

describe('validateConfigInvariants — tableName (entry #4)', () => {
  it('throws when tableName is undefined', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: undefined as unknown as ResolvedConfig['tableName'] };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('throws when tableName is an empty string', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: '' };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('throws when tableName is whitespace-only', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: '   ' };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('does NOT throw when tableName is a function (thunk is opaque at validate time)', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: () => 'resolved_at_runtime' };
    expect(() => validateConfigInvariants(cfg)).not.toThrow();
  });

  it('does NOT throw when tableName is a non-empty string', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: 'app_table' };
    expect(() => validateConfigInvariants(cfg)).not.toThrow();
  });

  it('error.details.field === "tableName" when tableName is missing', () => {
    const cfg: ResolvedConfig = { ...baseConfig, tableName: undefined as unknown as ResolvedConfig['tableName'] };
    try {
      validateConfigInvariants(cfg);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as EDBConfigInvariantViolationError;
      expect((err.details as { field: string }).field).toBe('tableName');
    }
  });
});

describe('validateConfigInvariants — remote (entries #3 / #5)', () => {
  it('does NOT throw when remote is undefined', () => {
    const cfg: ResolvedConfig = { ...baseConfig, remote: undefined };
    expect(() => validateConfigInvariants(cfg)).not.toThrow();
  });

  it('does NOT throw when remote has both url and apiKey populated', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      remote: { url: 'https://example.com', apiKey: 'secret' },
    };
    expect(() => validateConfigInvariants(cfg)).not.toThrow();
  });

  it('throws when remote is defined but url is missing', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      remote: { apiKey: 'k' } as unknown as ResolvedConfig['remote'],
    };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('throws when remote is defined but apiKey is missing', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      remote: { url: 'u' } as unknown as ResolvedConfig['remote'],
    };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('throws when remote.url is whitespace-only', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      remote: { url: '   ', apiKey: 'k' },
    };
    expect(() => validateConfigInvariants(cfg)).toThrow(EDBConfigInvariantViolationError);
  });

  it('error names both missing fields when both are absent', () => {
    const cfg: ResolvedConfig = {
      ...baseConfig,
      remote: {} as unknown as ResolvedConfig['remote'],
    };
    try {
      validateConfigInvariants(cfg);
      throw new Error('expected to throw');
    } catch (e) {
      const err = e as EDBConfigInvariantViolationError;
      expect((err.details as { missing: string[] }).missing).toEqual(['remote.url', 'remote.apiKey']);
    }
  });
});
