# ElectroDB Cross-Version Fingerprint Fixtures

**Owner:** DRF-07 — Phase 2, Plan 06 (Drift Detection & Authoring Loop).

This directory holds synthetic `EntityProjection` fixtures for three pinned
ElectroDB minor versions (3.0, 3.5, latest 3.x) used by
`tests/unit/drift/cross-version.test.ts`. Together with the test, they verify
that `fingerprintEntityModel` and `classifyDrift` are stable across the
ElectroDB compat range — i.e., the same conceptual schema produces the same
projection bytes (and therefore the same hash and zero drift records) on every
supported ElectroDB minor.

## Path B: synthetic projections, NOT npm-aliased real installs

Per RESEARCH §Open Question Q5 (Phase 2), Path B is locked. Instead of
installing three side-by-side ElectroDB versions via npm aliases (`electrodb-30`,
`electrodb-35`, `electrodb-37`), we hand-craft three `EntityProjection`-typed
fixtures that mirror the parsed-model output the projection's allowlist would
produce when run against each version's `entity.model`.

### Why Path B

- **No three-way install drift.** The npm-alias approach forces every CI run
  (and every contributor's local install) to resolve three full ElectroDB
  trees. Path B keeps the test surface in the source tree, fully diffable.
- **The allowlist IS the contract.** `src/safety/fingerprint-projection.ts`
  defines a closed allowlist of fields that contribute to fingerprint identity.
  The cross-version test exercises that contract directly, not ElectroDB's
  internal `_parseModel` shape. If a future ElectroDB minor changes
  `entity.model` in a way the allowlist already tolerates, no fixture change
  is needed; if it changes in a way the allowlist DOESN'T tolerate, the test
  fails — naming the offending field. That failure is the early-warning
  signal the suite is designed to produce.
- **Identical fixtures today are the success signal.** As of 2026-05-03 the
  v3.0, v3.5, and v3.7 fixtures are byte-identical because no parsed-model
  shape change between those versions is observable through the projection
  allowlist. That's the property under test.

## Canonical User schema (used by all three fixtures)

| Field            | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `entity`         | `User`                                                               |
| `service`        | `app`                                                                |
| `attributes.id`  | `{ type: 'string', required: true, hidden: false, readOnly: true }`  |
| `attributes.email` | `{ type: 'string', required: true, hidden: false, readOnly: false }` |
| `attributes.status` | `{ type: 'string', required: false, enumArray: ['active', 'inactive'] }` |
| `indexes.primary` | `{ type: 'isolated', pk: { field: 'pk', composite: ['id'] }, sk: { field: 'sk', composite: [] } }` |

Each fixture exports a single named binding:

- `tests/fixtures/electrodb-versions/v3.0.ts` → `userProjection_v3_0`
- `tests/fixtures/electrodb-versions/v3.5.ts` → `userProjection_v3_5`
- `tests/fixtures/electrodb-versions/v3.7.ts` → `userProjection_v3_7`

All three are typed as `EntityProjection` (imported from
`src/safety/fingerprint-projection.ts`) and consumed directly by the
cross-version test — i.e., they ARE the output of `projectEntityModel`,
not raw `entity.model` inputs.

## Adding a new ElectroDB version

When a future ElectroDB minor (e.g., 3.8 or 4.0-rc) ships:

1. Create `tests/fixtures/electrodb-versions/v3.8.ts` with the same canonical
   User schema as `v3.7.ts`. Initially it will be byte-identical.
2. Run `tests/unit/drift/cross-version.test.ts` — it should still pass
   (fingerprint stability + zero drift across all pairs including the new
   one). If it fails, the new version's parsed-model shape includes a field
   the allowlist preserves but the existing fixtures don't — that's a real
   drift signal. Update the fixtures to match the new parsed shape; the
   classifier will now fail until the projection allowlist is widened to
   normalize the difference.
3. Add a fourth tuple to the `describe.each` matrix and the
   `self-reflexivity` `it.each` matrix in
   `tests/unit/drift/cross-version.test.ts`.
4. Bump the test description from "11+ tests" to the new count in the plan
   summary if needed.

## What this directory does NOT contain

- No real ElectroDB `Entity` instances — those would require a runtime
  ElectroDB peer-dep import, which v0.1's test surface doesn't need.
- No `defineMigration` examples — see `tests/unit/migration/` for that.
- No `_parseModel`-style raw inputs — `tests/unit/safety/fingerprint-projection.test.ts`
  exercises the projection function via its own `makeModel()` builder.
  This directory's fixtures are the OUTPUT of projection, the post-allowlist
  shape, fed directly into `classifyDrift`.
