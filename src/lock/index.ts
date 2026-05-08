// Pattern: name every symbol explicitly; never `export *`.
// Mirror: src/safety/index.ts and src/state-mutations/index.ts.
//
// Note (Task 1 ↔ Task 2 ordering — deviation Rule 3): Task 1 of Plan 03-04
// creates the four files below; Task 2 adds `heartbeat.ts` and re-exports
// `startLockHeartbeat` / `StartLockHeartbeatArgs` from this barrel. The
// staged barrel keeps `pnpm typecheck` green between commits — no consumer
// inside `src/` imports `startLockHeartbeat` until Plan 04's runner.
export { acquireLock } from './acquire.js';
export { type LockRowSnapshot, readLockRow } from './read-lock-row.js';
export { staleCutoffIso } from './stale-cutoff.js';
export { forceUnlock } from './unlock.js';
