import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { MigrationsClient } from '../core/client.js';
import { MigrationInProgressError } from '../errors.js';
import { type CachedGuardState, createGuardCache } from './cache.js';
import { isReadCommand } from './command-classification.js';

export type WrapClientOptions = {
  client: DynamoDBClient | DynamoDBDocumentClient;
  migrationsClient: MigrationsClient;
  cacheTtlMs?: number;
  blockMode?: 'all' | 'writes-only';
  failureMode?: 'closed' | 'open';
};

const DEFAULT_TTL_MS = 1000;

// Both DynamoDBClient and DynamoDBDocumentClient expose `.config` (the doc
// client shares the inner raw's config object by reference). Either is a
// valid input — we extract a small set of primitive fields and build a sibling
// raw client so the new middleware stack is isolated from the input's stack.
//
// We deliberately do NOT pass the resolved config back through `new
// DynamoDBClient(config)`. The resolved config contains instantiated objects
// (retryStrategy, requestHandler, ...) whose internal shape is not stable
// across `@smithy` versions; rehydrating them through the constructor breaks
// in subtle ways (e.g. `retryStrategy.retry is not a function`). Carry
// region/endpoint/credentials only and let the SDK build a fresh stack.
const extractSafeConfig = (client: WrapClientOptions['client']): DynamoDBClientConfig => {
  // biome-ignore lint/suspicious/noExplicitAny: resolved-config type is internal
  const c = (client as unknown as { config: any }).config ?? {};
  const safe: DynamoDBClientConfig = {};
  if (c.region !== undefined) safe.region = c.region;
  if (c.endpoint !== undefined) safe.endpoint = c.endpoint;
  if (c.credentials !== undefined) safe.credentials = c.credentials;
  if (c.useDualstackEndpoint !== undefined) safe.useDualstackEndpoint = c.useDualstackEndpoint;
  if (c.useFipsEndpoint !== undefined) safe.useFipsEndpoint = c.useFipsEndpoint;
  if (c.maxAttempts !== undefined) safe.maxAttempts = c.maxAttempts;
  if (c.retryMode !== undefined) safe.retryMode = c.retryMode;
  return safe;
};

// Build a guard middleware that consults the cache and throws
// MigrationInProgressError before the SDK's retry middleware can see the
// rejection (we attach at step='build' with priority='high').
const buildGuardMiddleware = (
  cache: ReturnType<typeof createGuardCache>,
  blockMode: 'all' | 'writes-only',
) => {
  return (next: (args: unknown) => Promise<unknown>, context: { commandName?: string }) =>
    async (args: unknown): Promise<unknown> => {
      if (blockMode === 'writes-only' && isReadCommand(context.commandName)) {
        return next(args);
      }
      const state = await cache.get();
      if (state.blocked) throw fromCachedState(state);
      return next(args);
    };
};

const fromCachedState = (state: Extract<CachedGuardState, { blocked: true }>) => {
  if (state.reason === 'guard-check-failed') {
    return new MigrationInProgressError({
      reason: 'guard-check-failed',
      cause: state.cause,
    });
  }
  return new MigrationInProgressError({
    reasons: state.reasons,
    ...(state.lock ? { lock: state.lock } : {}),
    ...(state.failedMigrations ? { failedMigrations: state.failedMigrations } : {}),
    ...(state.deploymentBlockedIds ? { deploymentBlockedIds: state.deploymentBlockedIds } : {}),
  });
};

// Builds a DDB-call guard. Returns a NEW DynamoDBDocumentClient sharing
// nothing with the input — the wrapper internally constructs an isolated
// DynamoDBClient from the input's config so that adding middleware here
// can't leak into the migration runner's client.
//
// See plan/M2.5 for why isolation requires a sibling raw client (the
// SDK shares middlewareStack by reference between DocClient wrappers).
export const wrapClientWithMigrationGuard = (opts: WrapClientOptions): DynamoDBDocumentClient => {
  const config = extractSafeConfig(opts.client);
  const isolatedRaw = new DynamoDBClient(config);
  const guarded = DynamoDBDocumentClient.from(isolatedRaw);

  const cache = createGuardCache(() => opts.migrationsClient.getGuardState(), {
    ttlMs: opts.cacheTtlMs ?? DEFAULT_TTL_MS,
    failureMode: opts.failureMode ?? 'closed',
  });

  const middleware = buildGuardMiddleware(cache, opts.blockMode ?? 'all');

  guarded.middlewareStack.add(
    // biome-ignore lint/suspicious/noExplicitAny: AWS SDK middleware generics
    middleware as any,
    {
      step: 'build',
      name: 'electrodb-migrations:guard',
      priority: 'high',
    },
  );

  return guarded;
};
