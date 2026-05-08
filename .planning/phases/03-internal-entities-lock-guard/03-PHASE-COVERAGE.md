# Phase 3 Coverage Audit

> Companion document to `tests/unit/integration-coverage-audit.test.ts` (Plan 03-08).

## What this audit is

A defense-in-depth tripwire that fails the build if any Phase 3 requirement ID disappears from every test file's source. The audit does NOT measure functional coverage (assertion strength, branch coverage, etc.) — it measures **breadcrumb coverage**: can a reviewer following a requirement ID grep their way from the requirement to the test that defends it?

When a requirement ID stops appearing in any test file, the trail breaks. Code review can no longer connect "REQUIREMENTS.md says X" to "this test file proves X". The audit catches that disappearance.

## Why a `KNOWN_GAPS` allowlist

A failing test on every run is noise. The audit exists to catch _silent_ disappearance of an ID — not to grandfather in pre-existing gaps.

Real, tracked gaps live in `KNOWN_GAPS` inside the audit file with:
- The gap's requirement ID
- A non-trivial rationale (≥40 characters; the test enforces this)
- A pointer to the SUMMARY where the gap is logged for orchestrator follow-up

Untracked gaps fail the build. The asymmetry is intentional: documented gaps are reviewable; silent gaps are bugs.

## Scope of audit

| Field | Value |
|---|---|
| **Test corpus** | `tests/unit/**/*.ts` and `tests/integration/**/*.ts` |
| **Excluded from corpus** | `tests/fixtures/**` (these are inputs, not coverage); the audit file itself (it enumerates every ID, so including it would self-satisfy) |
| **Phase 3 requirement IDs (24)** | `ENT-01..06` (6), `LCK-01..10` (10), `GRD-01..07` (7), `BLD-04` (1) |
| **Match form** | Literal substring (`corpus.includes(id)`) — the canonical placement is inside a `describe(...)` or `it(...)` label, but a leading JSDoc paragraph is acceptable |

## How an ID earns coverage

The grep target is the literal string. Conventionally:

```ts
describe('createMigrationsEntity (ENT-01, ENT-03, ENT-05)', () => { ... });
```

Or in test-file JSDoc:

```ts
/**
 * LCK-04 source-scan tripwire — Plan 03-08 defense-in-depth.
 * ...
 */
```

Both forms register the ID for the audit. The audit does NOT inspect the assertion logic — that is the job of the test itself. The audit only proves the breadcrumb exists.

## When the audit fires

1. **A test file is renamed/deleted, dropping the only occurrence of an ID.** The audit fires; the author either (a) moves the assertion to a new file (preserving the ID literal) or (b) adds the ID to `KNOWN_GAPS` with a SUMMARY pointer for the loss.
2. **A future plan introduces a new Phase 3 requirement ID.** The audit fires until a test file mentions the new ID.
3. **A `describe`/`it` label is "tidied up" and loses the ID prefix.** The audit fires; the author reinstates the breadcrumb.

## When the audit MUST NOT be relaxed

Adding an ID to `KNOWN_GAPS` without a SUMMARY pointer or a real rationale is forbidden — the rationale-length assertion (`> 40` characters) catches the trivial case. If a reviewer sees a one-line "TODO" rationale, that is a code-smell flag. The third `it` in the audit enforces this; future contributors who try to silence the audit by stuffing a placeholder string will be caught.

## Current `KNOWN_GAPS` entries

| ID | Reason | Tracked in |
|---|---|---|
| `LCK-06` | No Phase 3 test references this ID. The literal is absent from `src/`, every Phase 3 test file, and every Phase 3 SUMMARY. Plan 03-08 surfaces it for orchestrator follow-up rather than silently inserting it. | `03-08-SUMMARY.md` "Phase-3 Coverage Gaps" section |

## Goal state

`KNOWN_GAPS = []`. Every entry above is a Phase 3 follow-up. The audit becomes stricter automatically as gaps close — closing an entry simply means deleting the array element, and the next test run will demand that the corresponding ID literal appear in some test file.

## Why this is a defense-in-depth layer (not the primary defense)

Each requirement ID has its own behavior test (e.g., `tests/unit/guard/lock-state-set.test.ts` proves `GATING_LOCK_STATES` excludes `'finalize'`). Those tests defend the contract. The audit defends the _navigability_ of those tests — it makes sure that when REQUIREMENTS.md GRD-04 is amended, a reviewer can find every test that depends on the change in seconds, not minutes.

The audit complements:
- `tests/unit/lock/source-scan.test.ts` — defends specific source-tree disciplines (`CONSISTENT_READ`, no `setInterval`)
- `tests/unit/lock/acquire-wait-seam.test.ts` — defends the `LCK-04` seam JSDoc on `src/lock/acquire.ts`
- `tests/unit/guard/source-scan-decision-a7.test.ts` — defends the `WAVE0-NOTES Decision A7` citation on `src/guard/lock-state-set.ts`

Together these four files form the Plan 03-08 tripwire suite. None of them assert behavior; all of them assert _navigability_.
