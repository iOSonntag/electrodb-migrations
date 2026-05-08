import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';
import { CONSISTENT_READ } from '../safety/index.js';

/**
 * The on-disk shape of `_migration_state` after a strongly-consistent read.
 *
 * Optional fields are omitted (not null-typed) when ElectroDB returns the row
 * without a value for them — e.g. a fresh `{lockState: 'free'}` row has no
 * `lockHolder`/`lockRunId`/etc. Sets (`inFlightIds`, `failedIds`, `releaseIds`)
 * are surfaced as `ReadonlySet<string>` so callers cannot mutate the captured
 * shape.
 */
export interface LockRowSnapshot {
  id: 'state';
  schemaVersion: number;
  updatedAt: string;
  lockState: 'free' | 'apply' | 'rollback' | 'finalize' | 'release' | 'failed' | 'dying';
  lockHolder?: string;
  lockRunId?: string;
  lockMigrationId?: string;
  lockAcquiredAt?: string;
  heartbeatAt?: string;
  inFlightIds?: ReadonlySet<string>;
  failedIds?: ReadonlySet<string>;
  releaseIds?: ReadonlySet<string>;
}

/**
 * The ONLY place `src/lock/` and `src/guard/` (Plan 05) read the
 * `_migration_state` row. Centralizing the read keeps the LCK-07 / GRD-02
 * invariant trivial to enforce: every consumer goes through this helper, and
 * the source-scan unit test (`tests/unit/lock/source-scan.test.ts`) fails the
 * build if any other file under `src/lock/` calls `migrationState.get(...)`.
 *
 * **MANDATORY: `consistent: CONSISTENT_READ`.** Pitfall #1 mitigation. The
 * named import (rather than an inline `consistent: true`) lets code review and
 * the source-scan greppers identify omissions at a glance.
 *
 * **ElectroDB option name verified.** `electrodb@3.7.5` (`index.d.ts:2653`)
 * exposes the strongly-consistent read flag as `consistent: boolean` on
 * single-item `.go(...)` options. The literal value MUST be `true`; the
 * `CONSISTENT_READ` constant is the named import that satisfies that contract.
 *
 * Returns `null` when the row does not exist (fresh project, never bootstrapped).
 */
export async function readLockRow(service: MigrationsServiceBundle): Promise<LockRowSnapshot | null> {
  const res = await service.migrationState.get({ id: MIGRATION_STATE_ID }).go({ consistent: CONSISTENT_READ });
  return (res as { data: LockRowSnapshot | null }).data ?? null;
}
