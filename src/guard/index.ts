// Pattern: name every symbol explicitly; never `export *`.
// Mirror: src/safety/index.ts, src/state-mutations/index.ts, src/lock/index.ts.
export { createLockStateCache, type LockStateCache, type LockStateValue } from './cache.js';
export { isReadCommand } from './classify.js';
export { GATING_LOCK_STATES } from './lock-state-set.js';
export { wrapClient, runUnguarded, type WrapClientArgs } from './wrap.js';
