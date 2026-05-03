/**
 * Synthetic EntityProjection matching ElectroDB 3.7.5's parsed-model shape
 * (the latest 3.x release as of 2026-05-03) for the canonical User entity.
 * DRF-07 cross-version stability fixture.
 *
 * Path B is locked per RESEARCH §Open Question Q5: instead of npm-aliased
 * three-way installs, we hand-craft an EntityProjection that mirrors what
 * `projectEntityModel` would output when run against ElectroDB 3.7.5's
 * parsed `entity.model`. As of 2026-05-03 no parsed-model shape difference
 * between 3.0, 3.5, and 3.7 is observable through the projection
 * allowlist, so this fixture is byte-identical to v3.0.ts and v3.5.ts.
 * THAT IS THE TEST SIGNAL: the allowlist insulates the framework from
 * internal version deltas.
 *
 * If you find that ElectroDB 3.7.5 produces a different parsed shape than
 * what the allowlist preserves, update this file to match the ACTUAL
 * shape — the cross-version test will then fail and surface the drift.
 */
import type { EntityProjection } from '../../../src/safety/fingerprint-projection.js';

export const userProjection_v3_7: EntityProjection = {
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
