/**
 * Unit tests for `classifyOwner` and `extractDomainKey` — the two pure
 * identity-stamp utility functions that power the RBK-04 / RBK-11 type-table
 * classifier.
 *
 * Uses REAL ElectroDB Entity instances (not stubs) because both functions
 * delegate to ElectroDB internal APIs (`entity.ownsItem`, `entity.parse`,
 * `entity.schema.indexes.byId.pk.composite`) that must be exercised
 * end-to-end.
 *
 * Reference: Plan 05-03, RESEARCH §Section 2 lines 1041-1080.
 */

import { Entity } from 'electrodb';
import { describe, expect, it } from 'vitest';
import { classifyOwner, extractDomainKey } from '../../../src/rollback/identity-stamp.js';
import { createUserV1, createUserV2 } from '../../_helpers/sample-migrations/User-add-status-with-down/index.js';

// ---------------------------------------------------------------------------
// Minimal stub DDB doc client — ElectroDB Entity constructors require a
// client reference but ownsItem / parse / schema access does NOT call DDB.
// The `send` function is required by ElectroDB's client validation.
// ---------------------------------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: minimal stub — only the constructor shape matters
const stubClient = { send: () => {} } as any;
const STUB_TABLE = 'stub-table';

// ---------------------------------------------------------------------------
// Entity instances used by classifyOwner tests
// ---------------------------------------------------------------------------
const userV1 = createUserV1(stubClient, STUB_TABLE);
const userV2 = createUserV2(stubClient, STUB_TABLE);

// Team entity (distinct entity name — should never be owned by User v1/v2)
const teamV1 = new Entity(
  {
    model: { entity: 'Team', version: '1', service: 'app' },
    attributes: {
      id: { type: 'string', required: true },
      teamLabel: { type: 'string', required: true },
    },
    indexes: {
      byId: {
        pk: { field: 'pk', composite: ['id'] },
        sk: { field: 'sk', composite: [] },
      },
    },
  },
  { client: stubClient, table: STUB_TABLE },
);

// ---------------------------------------------------------------------------
// Helpers to build raw DDB-style records with identity stamps
// ---------------------------------------------------------------------------

/** Build a raw record that looks like it was written by a User v1 entity. */
function makeUserV1Record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'User#u-1',
    sk: '$app_1#user_1',
    __edb_e__: 'User',
    __edb_v__: '1',
    id: 'u-1',
    name: 'Alice',
    ...overrides,
  };
}

/** Build a raw record that looks like it was written by a User v2 entity. */
function makeUserV2Record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'User#u-1',
    sk: '$app_2#user_2#version_v2',
    __edb_e__: 'User',
    __edb_v__: '2',
    id: 'u-1',
    name: 'Alice',
    status: 'active',
    version: 'v2',
    ...overrides,
  };
}

/** Build a raw record that looks like it was written by a Team v1 entity. */
function makeTeamV1Record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: 'Team#t-1',
    sk: '$app_1#team_1',
    __edb_e__: 'Team',
    __edb_v__: '1',
    id: 't-1',
    teamLabel: 'Engineering',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyOwner
// ---------------------------------------------------------------------------

describe('classifyOwner', () => {
  it('returns "v1" for a record owned by the v1 User entity', () => {
    const record = makeUserV1Record();
    expect(classifyOwner(record, userV1, userV2)).toBe('v1');
  });

  it('returns "v2" for a record owned by the v2 User entity', () => {
    const record = makeUserV2Record();
    expect(classifyOwner(record, userV1, userV2)).toBe('v2');
  });

  it('returns null for a Team record (neither v1 nor v2 User entity owns it)', () => {
    const record = makeTeamV1Record();
    expect(classifyOwner(record, userV1, userV2)).toBeNull();
  });

  it('returns null for a record missing __edb_e__ and __edb_v__ (ownsItem requires both)', () => {
    const record: Record<string, unknown> = { id: 'u-1', name: 'Alice' };
    expect(classifyOwner(record, userV1, userV2)).toBeNull();
  });

  it('returns null for an empty record {}', () => {
    expect(classifyOwner({}, userV1, userV2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractDomainKey
// ---------------------------------------------------------------------------

describe('extractDomainKey', () => {
  it('returns "id=u-1" for a User v1 record with id="u-1" (composite is ["id"])', () => {
    const record = makeUserV1Record({ id: 'u-1' });
    expect(extractDomainKey(userV1, record)).toBe('id=u-1');
  });

  it('returns the same domain key for a User v2 record with the same id (v1 and v2 share PK composite)', () => {
    const v1Record = makeUserV1Record({ id: 'u-42' });
    const v2Record = makeUserV2Record({ id: 'u-42' });
    expect(extractDomainKey(userV1, v1Record)).toBe(extractDomainKey(userV2, v2Record));
    expect(extractDomainKey(userV1, v1Record)).toBe('id=u-42');
  });

  it('returns a deterministic "&"-joined key for a multi-field PK composite', () => {
    // Build a synthetic entity with 2-attribute pk composite [tenantId, id].
    const multiEntity = new Entity(
      {
        model: { entity: 'MultiKey', version: '1', service: 'app' },
        attributes: {
          tenantId: { type: 'string', required: true },
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
        indexes: {
          byId: {
            pk: { field: 'pk', composite: ['tenantId', 'id'] },
            sk: { field: 'sk', composite: [] },
          },
        },
      },
      { client: stubClient, table: STUB_TABLE },
    );

    // Build a raw record that looks like it came from this entity.
    const rawRecord: Record<string, unknown> = {
      pk: '$app_1#multikey_1#tenantid_t-1#id_u-1',
      sk: '$app_1#multikey_1',
      __edb_e__: 'MultiKey',
      __edb_v__: '1',
      tenantId: 't-1',
      id: 'u-1',
      name: 'Alice',
    };

    expect(extractDomainKey(multiEntity, rawRecord)).toBe('tenantId=t-1&id=u-1');
  });

  it('reads from user-domain shape via entity.parse (not from byte-level pk/sk)', () => {
    // Verify by passing a record with different pk/sk but correct domain attrs.
    // The key should reflect user-domain attribute values, not the pk/sk bytes.
    const record = makeUserV1Record({ id: 'u-999' });
    const key = extractDomainKey(userV1, record);
    expect(key).toBe('id=u-999');
    // Verify the raw pk byte is NOT the key itself.
    expect(key).not.toBe(record.pk as string);
  });
});
