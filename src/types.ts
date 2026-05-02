import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MigrationDefinition } from './core/define-migration.js';
import type { LockOperation } from './errors.js';

export type MigrationStatus = 'pending' | 'applied' | 'finalized' | 'failed' | 'reverted';

export type MigrationProgressEvent =
  | { type: 'lock-acquired'; refId: string; operation: LockOperation; migrationId: string }
  | { type: 'lock-released'; refId: string }
  | { type: 'heartbeat'; refId: string; at: string }
  | { type: 'operation-start'; operation: LockOperation; migrationId: string }
  | {
      type: 'operation-complete';
      operation: LockOperation;
      migrationId: string;
      durationMs: number;
    }
  | { type: 'scan-page'; page: number; count: number }
  | { type: 'transform-batch'; count: number }
  | { type: 'write-batch'; count: number }
  | { type: 'error'; error: Error; item?: unknown };

// Shape of a row in the _migrations entity (DDB source of truth).
export interface MigrationRecord {
  id: string;
  status: MigrationStatus;
  appliedAt?: string;
  finalizedAt?: string;
  revertedAt?: string;
  appliedBy?: string;
  fromVersion: string;
  toVersion: string;
  entityName: string;
  fingerprint: string;
  itemCounts?: {
    scanned?: number;
    migrated?: number;
    skipped?: number;
    failed?: number;
  };
  error?: string;
}

export interface IdentifiersConfig {
  entity?: string;
  version?: string;
}

// Configuration for createMigrationsClient — set once, used for the lifetime of the client.
export interface CreateMigrationsClientOptions {
  client: DynamoDBDocumentClient;
  table: string;
  identifiers?: IdentifiersConfig;
  appliedBy?: string;
  staleThresholdMs?: number;
  heartbeatMs?: number;
  acquireWaitMs?: number;
}

export interface ApplyOptions {
  // biome-ignore lint/suspicious/noExplicitAny: must accept any migration regardless of its entity type pair
  migrations: MigrationDefinition<any, any>[];
  onProgress?: (event: MigrationProgressEvent) => void;
  concurrent?: number;
  // Default: false. When false, a successful apply leaves a deployment block on
  // the migration id — the runner mutex releases but the guard wrapper keeps
  // throwing until releaseDeploymentBlock is called. Workflow: migrate →
  // deploy new code → release. Set true to clear any existing block on success.
  autoRelease?: boolean;
}

export interface FinalizeOptions {
  // biome-ignore lint/suspicious/noExplicitAny: same as ApplyOptions
  migration: MigrationDefinition<any, any>;
  onProgress?: (event: MigrationProgressEvent) => void;
  concurrent?: number;
}

export interface RollbackOptions {
  // biome-ignore lint/suspicious/noExplicitAny: same as ApplyOptions
  migration: MigrationDefinition<any, any>;
  onProgress?: (event: MigrationProgressEvent) => void;
  concurrent?: number;
  // Same semantics as ApplyOptions.autoRelease — default false; on true, clears
  // any existing deployment block for this migration.
  autoRelease?: boolean;
}

export interface GetStatusOptions {
  migrationId: string;
}

export interface EnsureAppliedOptions {
  // biome-ignore lint/suspicious/noExplicitAny: same as ApplyOptions
  migrations: MigrationDefinition<any, any>[];
  mode: 'verify' | 'strict';
}

export interface ReleaseDeploymentBlockOptions {
  migrationId: string;
}

// Returned by client.getLockState() — drives the future API guard middleware.
export type MigrationLockState =
  | { locked: false }
  | {
      locked: true;
      stale: boolean;
      heldBy: string;
      operation: LockOperation;
      migrationId: string;
      acquiredAt: string;
      heartbeatAt: string;
      refId: string;
    };

// Reasons the guard considers traffic blocked. The state can match more than
// one reason at the same time (lock held AND failed migration AND deployment
// block, etc.) — they're set bits, not a discriminator.
export type MigrationBlockReason = 'locked' | 'failed-migration' | 'deployment-block';

// Returned by client.getGuardState() — drives the wrap-client middleware.
// `reasons` is a non-empty array on `blocked: true`; payload fields are
// populated independently based on which reasons are present.
export type MigrationGuardState =
  | { blocked: false }
  | {
      blocked: true;
      reasons: MigrationBlockReason[];
      lock?: Extract<MigrationLockState, { locked: true }>;
      failedMigrations?: { id: string; error?: string }[];
      deploymentBlockedIds?: string[];
    };
