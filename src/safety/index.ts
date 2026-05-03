export { CONSISTENT_READ, CONSISTENT_READ_MARKER } from './consistent-read.js';
export { startHeartbeatScheduler, type HeartbeatOptions, type HeartbeatScheduler } from './heartbeat-scheduler.js';
export { EDBBatchWriteExhaustedError, withBatchWriteRetry, type BatchWriteRetryOptions, type BatchWriteRetryResult } from './batch-write-retry.js';
export { fingerprintEntityModel, projectEntityModel, type EntityProjection, type ProjectedAttribute, type ProjectedIndex, type ProjectedKey } from './fingerprint-projection.js';
