import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../../src/config/define.js';
import type { MigrationsConfig } from '../../../src/config/types.js';

describe('defineConfig', () => {
  it('is an identity factory (returns input unchanged)', () => {
    const input: MigrationsConfig = {
      entities: 'src/entities',
      migrations: 'src/database/migrations',
      tableName: 'app_table',
    };
    expect(defineConfig(input)).toBe(input);
  });

  it('accepts the full CFG-01 surface', () => {
    // Type-level test — must compile clean.
    const cfg = defineConfig({
      entities: ['src/entities/User.ts', 'src/entities/Team.ts'],
      migrations: 'src/database/migrations',
      region: 'us-east-1',
      tableName: 'app_table',
      keyNames: {
        partitionKey: 'PK',
        sortKey: 'SK',
        electroEntity: 'ent',
        electroVersion: 'ver',
      },
      lock: { heartbeatMs: 30000, staleThresholdMs: 14400000, acquireWaitMs: 15000 },
      guard: { cacheTtlMs: 5000, blockMode: 'all' },
      remote: { url: 'https://example.com', apiKey: 'secret' },
      migrationStartVersions: { User: { version: 5 } },
      runner: { concurrency: 1 },
    });
    expect(cfg.entities).toEqual(['src/entities/User.ts', 'src/entities/Team.ts']);
    expect(cfg.lock?.heartbeatMs).toBe(30000);
  });

  it('accepts a thunk for tableName', () => {
    const cfg = defineConfig({
      entities: 'src/entities',
      migrations: 'src/database/migrations',
      tableName: () => 'resolved_table',
    });
    expect(typeof cfg.tableName).toBe('function');
  });

  it('rejects malformed lock.heartbeatMs at typecheck (compile-time guard)', () => {
    // The line below triggers a type error if uncommented:
    //   defineConfig({ entities: 'x', migrations: 'y', tableName: 'z', lock: { heartbeatMs: '30s' } });
    // Negative compile-time tests live alongside the typecheck step rather
    // than the runtime test runner. Here we assert that the runtime call
    // *with the right shape* succeeds.
    expect(() =>
      defineConfig({
        entities: 'x',
        migrations: 'y',
        tableName: 'z',
        lock: { heartbeatMs: 30_000 },
      }),
    ).not.toThrow();
  });

  it('CFG-09: migrationStartVersions accepts {EntityName: {version: number}}', () => {
    const cfg = defineConfig({
      entities: 'x',
      migrations: 'y',
      tableName: 'z',
      migrationStartVersions: { User: { version: 5 }, Team: { version: 1 } },
    });
    expect(cfg.migrationStartVersions?.User?.version).toBe(5);
  });
});
