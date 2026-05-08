# User-add-status fixture

Sample migration used by Phase 4 runner unit + integration tests. Mirrors the
README §4 quick-start "add-status" example.

## Key-shape choice (B-01 — ROADMAP SC1 prerequisite)

v1 and v2 produce **PHYSICALLY DISTINCT** rows in DynamoDB:

| Frozen entity | `pk`           | `sk`                              | `__edb_e__` / `__edb_v__` |
|---------------|----------------|-----------------------------------|---------------------------|
| `UserV1`      | `$app_1#id_X`  | `$app_1#user_1`                   | `User` / `1`              |
| `UserV2`      | `$app_2#id_X`  | `$app_2#user_2#version_v2`        | `User` / `2`              |

(Exact byte sequence depends on ElectroDB's identifier serialization — what
matters is that BOTH (pk, sk) and the identity stamps differ.)

Because the (pk, sk) byte sequences differ, writing a v2 record via
`migration.to.put(...)` does NOT overwrite the v1 row. Post-apply, the table
contains 2N rows for N seeded v1 records:

- N rows owned by `UserV1` (untouched until finalize)
- N rows owned by `UserV2` (newly written by the runner)

This is what makes ROADMAP Phase 4 Success Criterion #1 testable:

> ElectroDB v1 query returns 1,000 hits AND v2 query returns 1,000

Without distinct SK shapes, v2 would overwrite v1 in place and only 1,000
total rows would exist — SC1 would be unverifiable.

## Why a `version` constant attribute and not a different `service` or `entity`?

- Different `service` name → v1 and v2 would no longer be the "same migration
  target" from ElectroDB's perspective; the framework would not consider them
  a v1→v2 pair.
- Different `entity` name → same problem; `__edb_e__` is the entity-name field.
- Adding a constant SK token → keeps the entity identity stable (`__edb_e__='User'`
  on both) while differentiating the physical row. This is the smallest change
  that satisfies SC1 without changing the migration's logical contract.

## Finalize semantics

`finalize <id>` deletes the v1 rows (queried via `migration.from.scan` →
`migration.from.delete`) leaving the v2 rows intact. After finalize the table
contains exactly N rows (the v2 ones).

## Files in this fixture

| File            | Purpose                                            |
|-----------------|----------------------------------------------------|
| `v1.ts`         | Frozen UserV1 entity factory (no `status` attr)    |
| `v2.ts`         | Frozen UserV2 entity factory (adds `status`, `version` SK token) |
| `migration.ts`  | `createUserAddStatusMigration` factory (uses `defineMigration`) |
| `index.ts`      | Barrel re-exporting all three factories            |
| `README.md`     | This file — documents B-01 rationale               |
