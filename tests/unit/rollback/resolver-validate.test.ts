/**
 * Unit tests for validateResolverResult — Pitfall 3 mitigation (RBK-08).
 *
 * Uses the real ElectroDB v1 entity from User-add-status/v1.ts to exercise
 * the `(v1Entity as any).put(result).params()` side-effect validation. The
 * v1 entity has only `id` and `name` attributes — any record with extra
 * attributes (e.g., `status`) should be rejected as a v2-shaped record.
 *
 * RESEARCH §Pitfall 3 lines 617-635: custom resolver returning a misshapen
 * record (e.g., a v2 object) would silently corrupt v1 rows on PUT. This
 * validation throws BEFORE the put batch is sent.
 */
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createUserV1 } from '../../../tests/_helpers/sample-migrations/User-add-status/v1.js';
import { validateResolverResult } from '../../../src/rollback/resolver-validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock DynamoDB client to satisfy Entity constructor. */
const mockClient = {} as unknown as DynamoDBDocumentClient;
const v1Entity = createUserV1(mockClient, 'test-table');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateResolverResult', () => {
  it('null result → {kind: "delete"}', async () => {
    const result = await validateResolverResult(v1Entity, null, 'id=u-1');
    expect(result).toEqual({ kind: 'delete' });
  });

  it('valid v1-shaped object → {kind: "put", v1: record}', async () => {
    const record = { id: 'u-1', name: 'Alice' };
    const result = await validateResolverResult(v1Entity, record, 'id=u-1');
    expect(result).toEqual({ kind: 'put', v1: record });
  });

  it('undefined result → throws Error with "undefined" and domainKey in message', async () => {
    await expect(validateResolverResult(v1Entity, undefined, 'id=u-1')).rejects.toThrow(
      /undefined.*id=u-1|id=u-1.*undefined/,
    );
  });

  it('string result → throws Error with "string" and domainKey in message', async () => {
    await expect(validateResolverResult(v1Entity, 'some-string', 'id=u-1')).rejects.toThrow(
      /string.*id=u-1|id=u-1.*string/,
    );
  });

  it('number result → throws Error with "number" and domainKey in message', async () => {
    await expect(validateResolverResult(v1Entity, 42, 'id=u-1')).rejects.toThrow(
      /number.*id=u-1|id=u-1.*number/,
    );
  });

  it('v2-shaped object (with extra status) → throws Error with "non-v1 shape" and domainKey', async () => {
    // The v1 entity only has id + name; status is unknown to it.
    // ElectroDB's put().params() should throw on an unrecognized attribute.
    const v2Record = { id: 'u-1', name: 'Alice', status: 'active' };
    await expect(validateResolverResult(v1Entity, v2Record, 'id=u-1')).rejects.toThrow(
      /non-v1 shape.*id=u-1|id=u-1.*non-v1 shape/,
    );
  });

  it('missing required name field → throws Error with "non-v1 shape" and domainKey', async () => {
    // name is required in v1; missing it should trigger ElectroDB validation error.
    const incompleteRecord = { id: 'u-1' };
    await expect(validateResolverResult(v1Entity, incompleteRecord, 'id=u-1')).rejects.toThrow(
      /non-v1 shape.*id=u-1|id=u-1.*non-v1 shape/,
    );
  });
});
