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

export { seedV1Records } from './seed-records.js';
export { seedV2Records } from './seed-v2-records.js';
export { seedMixedRecords, type SeedMixedRecordsArgs, type SeedMixedRecordsResult } from './seed-mixed-records.js';
