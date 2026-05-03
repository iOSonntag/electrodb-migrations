# ElectroDB Cross-Version Fingerprint Fixtures

This directory will hold fixtures pinning specific ElectroDB versions
(3.0.x, 3.5.x, latest 3.x) so the cross-version stability tests for
`fingerprintEntityModel` can verify the projection produces the same hash
across minor releases. DRF-07 (Phase 2) is the requirement that owns this.

For Phase 1 we ship the structural placeholder only. Phase 2 populates this
directory and adds a parameterized vitest suite that imports a canonical
`User` entity definition compiled against each pinned version, runs it
through `fingerprintEntityModel`, and asserts all three produce the same
hash.

## Why a directory + README, not a real fixture, in Phase 1?

Phase 1's RESEARCH allowlist was verified directly against ElectroDB 3.7.5's
source. Phase 2 introduces the runtime DDB-touching tests where the
cross-version matrix actually buys safety. Phase 1's tests use a synthetic
`makeModel()` builder that mirrors the parsed shape; Phase 2's tests use
real ElectroDB-parsed entities.

## Owner

DRF-07 → Phase 2 (Drift Detection & Authoring Loop).
