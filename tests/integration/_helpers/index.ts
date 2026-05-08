/**
 * Barrel for integration test helpers. All symbols are named explicitly — never
 * `export *` — so the test surface stays auditable.
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
  bootstrapMigrationState,
} from './ddb-local.js';

export { isDdbLocalReachable, skipMessage } from './docker-availability.js';

export { raceAcquires, type RaceResult } from './concurrent-acquire.js';

export {
  attachEventualConsistencyMiddleware,
  type EventualConsistencyHarness,
} from './eventual-consistency.js';
