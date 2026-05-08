/**
 * AWS SDK middleware that simulates DynamoDB's eventual-consistency window for
 * the `_migration_state` row. Required for BLD-04 — DDB Local does NOT reproduce
 * eventual consistency naturally, so guard tests cannot prove "ConsistentRead: true
 * is load-bearing" without this harness.
 *
 * The middleware registers at step `'finalizeRequest'` (intercepts immediately
 * before the wire send so it can short-circuit without disturbing earlier
 * stages). It matches a `GetItemCommand` against the lock row key
 * `pk='_migration_state' / sk='state'`; if `ConsistentRead` is falsy AND a
 * stale window is currently active AND a `previousState` has been recorded, it
 * returns a synthesized response carrying the recorded stale state. When
 * `ConsistentRead` is truthy, the simulator passes through to the next handler
 * unconditionally — that is the bypass channel the production guard relies on.
 *
 * This module is test-only. It MUST NOT be imported from `src/` — Plan 08
 * source-scan invariants enforce the boundary.
 */

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export interface EventualConsistencyHarness {
  /** Begin returning stale reads of the lock row for `durationMs`. */
  beginStaleWindow: (durationMs: number) => void;
  /** Record the value the simulator should return as "stale". Call after a real write. */
  recordWrite: (newState: Record<string, unknown>) => void;
  /** Number of GetItem calls that hit the stale path so far (for assertion). */
  staleHits: () => number;
}

interface MiddlewareInput {
  TableName?: string;
  Key?: {
    pk?: { S?: string } | string;
    sk?: { S?: string } | string;
  };
  ConsistentRead?: boolean;
}

const extractKeyComponent = (component: { S?: string } | string | undefined): string | undefined => {
  if (component === undefined) return undefined;
  if (typeof component === 'string') return component;
  return component.S;
};

export const attachEventualConsistencyMiddleware = (client: DynamoDBClient, tableName: string): EventualConsistencyHarness => {
  let previousState: Record<string, unknown> | null = null;
  let staleUntil = 0;
  let staleHitCount = 0;

  client.middlewareStack.add(
    (next, context) => async (args) => {
      const cmdName = (context as { commandName?: string }).commandName;
      const input = args.input as MiddlewareInput;
      const pk = extractKeyComponent(input.Key?.pk);
      const sk = extractKeyComponent(input.Key?.sk);

      const isLockRowGet = cmdName === 'GetItemCommand' && input.TableName === tableName && pk === '_migration_state' && sk === 'state' && !input.ConsistentRead;

      if (isLockRowGet && Date.now() < staleUntil && previousState) {
        staleHitCount += 1;
        // Synthesized response shape — `$metadata` is required by the AWS SDK
        // retry middleware (it sets `attempts` / `totalRetryDelay` on the
        // returned `response` object after the inner handler returns; without
        // it the assignment crashes with "Cannot set properties of undefined").
        // Verified against @smithy/middleware-retry@4.5.7 in Wave 0 spike.
        const synthesized = {
          output: {
            Item: previousState,
            $metadata: { attempts: 0, totalRetryDelay: 0 },
          },
          response: { $metadata: { attempts: 0, totalRetryDelay: 0 } },
        };
        return synthesized as never;
      }
      return next(args);
    },
    { step: 'finalizeRequest', name: 'eventual-consistency-simulator' },
  );

  return {
    beginStaleWindow: (durationMs) => {
      staleUntil = Date.now() + durationMs;
    },
    recordWrite: (newState) => {
      previousState = { ...newState };
    },
    staleHits: () => staleHitCount,
  };
};
