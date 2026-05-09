/**
 * Type-level test for the tightened `rollbackResolver` signature on `Migration<From, To>`.
 *
 * RBK-08 / RESEARCH OQ7: The `rollbackResolver` field is tightened from the Phase 2
 * placeholder `(...args: unknown[]) => unknown` to the specific
 * `(args: RollbackResolverArgs) => Promise<Record<string, unknown> | null | undefined>`.
 *
 * This is an additive widening — existing code that authored a resolver accepting `args: unknown`
 * continues to compile because `(args: unknown) => Promise<...>` is assignable to
 * `(args: RollbackResolverArgs) => Promise<...>` (function parameter contravariance).
 *
 * The tests below verify the structural contract for plan 05-07 / RBK-08.
 */
import type { Migration, RollbackResolverArgs } from '../../../src/migrations/index.js';
import { expectTypeOf } from 'vitest';

// ----------------------------------------------------------------------------
// RollbackResolverArgs shape
// ----------------------------------------------------------------------------

expectTypeOf<RollbackResolverArgs>().toHaveProperty('kind');
expectTypeOf<RollbackResolverArgs['kind']>().toEqualTypeOf<'A' | 'B' | 'C'>();
expectTypeOf<RollbackResolverArgs>().toHaveProperty('v1Original');
expectTypeOf<RollbackResolverArgs>().toHaveProperty('v2');
expectTypeOf<RollbackResolverArgs>().toHaveProperty('down');

// ----------------------------------------------------------------------------
// Migration.rollbackResolver parameter and return type
// ----------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: type-level test only
type AnyMigrationResolver = NonNullable<Migration<any, any>['rollbackResolver']>;

// Parameter must accept RollbackResolverArgs
expectTypeOf<AnyMigrationResolver>().parameter(0).toMatchTypeOf<RollbackResolverArgs>();

// Return type must be a Promise of v1Record | null | undefined
expectTypeOf<AnyMigrationResolver>().returns.toMatchTypeOf<
  Promise<Record<string, unknown> | null | undefined>
>();
