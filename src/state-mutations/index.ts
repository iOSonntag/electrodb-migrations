// Pattern: name every symbol explicitly; never `export *`.
// Mirror: src/safety/index.ts.
export { acquire, type AcquireArgs } from './acquire.js';
export { heartbeat, type HeartbeatArgs } from './heartbeat.js';
export { transitionToReleaseMode, type TransitionArgs } from './transition.js';
export { clear, type ClearArgs } from './clear.js';
export { clearFinalizeMode, type ClearFinalizeModeArgs } from './clear-finalize.js';
export { markFailed, type MarkFailedArgs } from './mark-failed.js';
export { appendInFlight, type AppendInFlightArgs } from './append-in-flight.js';
export { unlock, type UnlockArgs, type UnlockResult } from './unlock.js';
export {
  isConditionalCheckFailed,
  extractCancellationReason,
  type CancellationReason,
} from './cancellation.js';
