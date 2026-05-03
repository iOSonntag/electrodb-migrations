/**
 * Synthetic EntityProjection matching ElectroDB 3.0.0's parsed-model shape
 * for the canonical User entity. DRF-07 cross-version stability fixture.
 *
 * Path B is locked per RESEARCH §Open Question Q5: instead of npm-aliased
 * three-way installs, we hand-craft an EntityProjection that mirrors what
 * `projectEntityModel` would output when run against ElectroDB 3.0.0's
 * parsed `entity.model`. The drift classifier and fingerprint hash consume
 * the EntityProjection directly — so as long as the projection's
 * allowlist (`src/safety/fingerprint-projection.ts`) tolerates the
 * version's parsed shape, this fixture stays byte-equal to the v3.5 and
 * v3.7 fixtures.
 *
 * If you find that ElectroDB 3.0.0 produces a different parsed shape than
 * what the allowlist preserves, update this file to match the ACTUAL
 * shape — the cross-version test will then fail and surface the drift.
 * That failure is the early warning the suite is designed to produce.
 */
import type { EntityProjection } from '../../../src/safety/fingerprint-projection.js';

export const userProjection_v3_0: EntityProjection = {
  entity: 'User',
  service: 'app',
  attributes: {
    id: { type: 'string', required: true, hidden: false, readOnly: true, field: 'id' },
    email: { type: 'string', required: true, hidden: false, readOnly: false, field: 'email' },
    status: {
      type: 'string',
      required: false,
      hidden: false,
      readOnly: false,
      field: 'status',
      enumArray: ['active', 'inactive'],
    },
  },
  indexes: {
    primary: {
      type: 'isolated',
      pk: { field: 'pk', composite: ['id'] },
      sk: { field: 'sk', composite: [] },
    },
  },
};
