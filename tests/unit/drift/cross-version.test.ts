import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyDrift } from '../../../src/drift/classify.js';
import type { EntityProjection } from '../../../src/safety/fingerprint-projection.js';
import { canonicalJson } from '../../../src/snapshot/canonical.js';
import { userProjection_v3_0 } from '../../fixtures/electrodb-versions/v3.0.js';
import { userProjection_v3_5 } from '../../fixtures/electrodb-versions/v3.5.js';
import { userProjection_v3_7 } from '../../fixtures/electrodb-versions/v3.7.js';

/**
 * DRF-07: cross-version stability of the drift classifier and fingerprint
 * projection. Path B per RESEARCH §Open Question Q5 — synthetic
 * EntityProjection fixtures hand-crafted to match each ElectroDB minor's
 * parsed-model output, NOT npm-aliased side-by-side installs.
 *
 * The fixture trio (v3.0, v3.5, v3.7) is byte-identical today because the
 * projection allowlist insulates the framework from internal parsed-model
 * deltas. The negative-control case proves this suite has discriminating
 * power: if the classifier ever stopped detecting real drift the suite
 * would still go red.
 */

/**
 * Mirror of `fingerprintEntityModel`'s post-projection hashing step. We
 * already HAVE EntityProjections (the fixtures); this helper applies the
 * same canonical-JSON + SHA-256 pipeline directly without going through
 * `projectEntityModel`. Determinism contract is identical to
 * `src/safety/fingerprint-projection.ts`.
 */
function fingerprintProjection(p: EntityProjection): string {
  return createHash('sha256').update(canonicalJson(p)).digest('hex');
}

describe('DRF-07: cross-version drift detector stability (Path B synthetic projections)', () => {
  describe('fingerprint stability', () => {
    it('all three ElectroDB versions produce equal fingerprints for the canonical User entity', () => {
      const fp0 = fingerprintProjection(userProjection_v3_0);
      const fp5 = fingerprintProjection(userProjection_v3_5);
      const fp7 = fingerprintProjection(userProjection_v3_7);
      expect(fp0).toBe(fp5);
      expect(fp5).toBe(fp7);
    });

    it('returns a 64-character lowercase hex SHA-256 digest (matches projection contract)', () => {
      expect(fingerprintProjection(userProjection_v3_0)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe.each([
    { from: '3.0', prev: userProjection_v3_0, to: '3.5', curr: userProjection_v3_5 },
    { from: '3.0', prev: userProjection_v3_0, to: '3.7', curr: userProjection_v3_7 },
    { from: '3.5', prev: userProjection_v3_5, to: '3.7', curr: userProjection_v3_7 },
  ])('classifyDrift($from, $to)', ({ prev, curr }) => {
    it('returns no drift records (versions are projection-equivalent)', () => {
      expect(classifyDrift(prev, curr)).toEqual([]);
    });

    it('returns no drift records in the reverse direction (symmetry)', () => {
      expect(classifyDrift(curr, prev)).toEqual([]);
    });

    it('classifier is deterministic on this pair (run twice, same output)', () => {
      const a = classifyDrift(prev, curr);
      const b = classifyDrift(prev, curr);
      expect(a).toEqual(b);
    });
  });

  describe('self-reflexivity per version', () => {
    it.each([
      { v: '3.0', p: userProjection_v3_0 },
      { v: '3.5', p: userProjection_v3_5 },
      { v: '3.7', p: userProjection_v3_7 },
    ])('classifyDrift(v$v, v$v) is empty', ({ p }) => {
      expect(classifyDrift(p, p)).toEqual([]);
    });
  });

  describe('negative control', () => {
    it('classifyDrift detects a subtle change against v3.0 (proves the test would fail on real drift)', () => {
      const baseId = userProjection_v3_0.attributes.id;
      if (!baseId) throw new Error('fixture invariant: v3.0 must have an `id` attribute');
      const subtlyDifferent: EntityProjection = {
        ...userProjection_v3_0,
        attributes: {
          ...userProjection_v3_0.attributes,
          id: { ...baseId, required: false }, // was true
        },
      };
      const drifts = classifyDrift(userProjection_v3_0, subtlyDifferent);
      expect(drifts.length).toBeGreaterThan(0);
      expect(drifts[0]?.kind).toBe('attribute-changed');
    });
  });
});
