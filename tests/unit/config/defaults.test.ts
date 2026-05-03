import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTITIES_PATH,
  DEFAULT_GUARD,
  DEFAULT_KEY_NAMES,
  DEFAULT_LOCK,
  DEFAULT_MIGRATIONS_PATH,
  DEFAULT_RUNNER,
} from '../../../src/config/defaults.js';

describe('DEFAULT_LOCK (CFG-06)', () => {
  it('heartbeatMs is 30_000', () => {
    expect(DEFAULT_LOCK.heartbeatMs).toBe(30_000);
  });

  it('staleThresholdMs is 4 hours (14_400_000ms)', () => {
    expect(DEFAULT_LOCK.staleThresholdMs).toBe(4 * 60 * 60 * 1000);
    expect(DEFAULT_LOCK.staleThresholdMs).toBe(14_400_000);
  });

  it('acquireWaitMs is 15_000', () => {
    expect(DEFAULT_LOCK.acquireWaitMs).toBe(15_000);
  });
});

describe('DEFAULT_GUARD (CFG-07)', () => {
  it('cacheTtlMs is 5_000', () => {
    expect(DEFAULT_GUARD.cacheTtlMs).toBe(5_000);
  });

  it("blockMode is 'all'", () => {
    expect(DEFAULT_GUARD.blockMode).toBe('all');
  });
});

describe('DEFAULT_RUNNER (CFG-08)', () => {
  it('concurrency is 1 (reserved slot, no-op in v0.1)', () => {
    expect(DEFAULT_RUNNER.concurrency).toBe(1);
  });
});

describe('DEFAULT_KEY_NAMES (CFG-05)', () => {
  it('matches the README §5.1.2 default attribute set', () => {
    expect(DEFAULT_KEY_NAMES).toEqual({
      partitionKey: 'pk',
      sortKey: 'sk',
      electroEntity: '__edb_e__',
      electroVersion: '__edb_v__',
    });
  });
});

describe('Cross-default invariant (Pitfall #2 sanity check)', () => {
  it('DEFAULT_GUARD.cacheTtlMs is strictly less than DEFAULT_LOCK.acquireWaitMs', () => {
    expect(DEFAULT_GUARD.cacheTtlMs).toBeLessThan(DEFAULT_LOCK.acquireWaitMs);
  });
});

describe('DEFAULT_ENTITIES_PATH / DEFAULT_MIGRATIONS_PATH (CFG-12)', () => {
  it("DEFAULT_ENTITIES_PATH is 'src/database/entities' (matches README §5.1.1)", () => {
    expect(DEFAULT_ENTITIES_PATH).toBe('src/database/entities');
  });

  it("DEFAULT_MIGRATIONS_PATH is 'src/database/migrations' (matches README §5.1.1)", () => {
    expect(DEFAULT_MIGRATIONS_PATH).toBe('src/database/migrations');
  });
});
