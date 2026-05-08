/**
 * Barrel for integration test helpers. All symbols are named explicitly — never
 * `export *` — so the test surface stays auditable.
 *
 * The eventual-consistency simulator (`./eventual-consistency.js`) is added by
 * Task 2 of Plan 03-01. Until that lands, only the lifecycle / availability /
 * race helpers are re-exported here.
 */

export {
  DDB_LOCAL_ENDPOINT,
  type DdbLocalClients,
  type CreateTestTableKeys,
  type SeedLockRowState,
  type SeedLockState,
  createTestTable,
  deleteTestTable,
  makeDdbLocalClient,
  randomTableName,
  seedLockRow,
} from './ddb-local.js';

export { isDdbLocalReachable, skipMessage } from './docker-availability.js';

export { raceAcquires, type RaceResult } from './concurrent-acquire.js';
