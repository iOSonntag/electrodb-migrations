---
phase: 7
slug: validate-regenerate-acknowledge-removal
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-09
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `07-RESEARCH.md` §Validation Architecture (line 573).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (verified in package.json) |
| **Config files** | `vitest.config.ts` (unit only — Phase 7 has zero DDB integration tests; the entire validate command is FS + entity-import) |
| **Quick run command** | `pnpm vitest run tests/unit/validate/ tests/unit/scaffold/regenerate.test.ts` |
| **Full suite command** | `pnpm vitest run` |
| **Estimated runtime** | ~30s unit (Phase 7 adds zero integration tests) |
| **Phase 6 baseline** | 994 unit + 9 Phase-6 integration tests green; 2 pre-existing Phase-4 failures (DI-04-15-01/02) carried as warnings |

---

## Sampling Rate

- **After every task commit:** `pnpm vitest run tests/unit/validate/` (~5s for the validate-only subset)
- **After every plan wave:** `pnpm vitest run` (~30s)
- **Before `/gsd-verify-work`:** Full unit suite green (Phase-7-attributable failures = 0)
- **Performance budget:** SC-1 says `validate` exits in < 1 second on a clean 20-entity / 40-migration repo. The performance test (`tests/unit/validate/performance.test.ts`) enforces this.
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

> Tasks are placeholders — exact `task_id` values land when `gsd-planner` writes PLAN.md files. Each plan must wire its tasks to one of the rows below.

| Requirement | Test Type | Automated Command | Status |
|-------------|-----------|-------------------|--------|
| **VAL-01** drift-without-migration | unit | `pnpm vitest run tests/unit/validate/rules/drift-without-migration.test.ts` | ⬜ Wave 0 |
| **VAL-02** version-skew | unit | `pnpm vitest run tests/unit/validate/rules/version-skew.test.ts` | ⬜ Wave 0 |
| **VAL-03** sequence-gaps (incl. `migrationStartVersions`) | unit | `pnpm vitest run tests/unit/validate/rules/sequence-gaps.test.ts` | ⬜ Wave 0 |
| **VAL-04** parallel-branch-collision | unit | `pnpm vitest run tests/unit/validate/rules/parallel-branch-collision.test.ts` | ⬜ Wave 0 |
| **VAL-05** cross-entity-ordering (FS-only — uses `migration.reads` extracted via `.model.entity`) | unit | `pnpm vitest run tests/unit/validate/rules/cross-entity-ordering.test.ts` | ⬜ Wave 0 |
| **VAL-06** removed-entities (tombstone gates pass/fail) | unit | `pnpm vitest run tests/unit/validate/rules/removed-entities.test.ts` | ⬜ Wave 0 |
| **VAL-07** reserved-namespace (`_`-prefixed entity name) | unit | `pnpm vitest run tests/unit/validate/rules/reserved-namespace.test.ts` | ⬜ Wave 0 |
| **VAL-08** frozen-snapshot-edited (hash mismatch on `v1.ts`/`v2.ts`) | unit | `pnpm vitest run tests/unit/validate/rules/frozen-snapshot-edited.test.ts` | ⬜ Wave 0 |
| **VAL-09** non-zero exit on findings; zero on clean | unit (CLI smoke) | `pnpm vitest run tests/unit/validate/exit-code.test.ts` | ⬜ Wave 0 |
| **VAL-10** `acknowledge-removal` writes tombstone; subsequent validate exits zero | unit | `pnpm vitest run tests/unit/validate/acknowledge-removal.test.ts` | ⬜ Wave 0 |
| **SCF-08** `create --regenerate <id>` rewrites v1.ts/v2.ts, preserves migration.ts byte-for-byte, updates integrity hash | unit | `pnpm vitest run tests/unit/scaffold/regenerate.test.ts` | ⬜ Wave 0 |
| **CLI-02** `--remote` ignored on validate, regenerate, acknowledge-removal | unit (CLI flag) | `pnpm vitest run tests/unit/cli/file-only-commands.test.ts` | ⬜ Wave 0 |

### Success Criteria — Performance Gate (SC-1)

| Property | Target | Test |
|----------|--------|------|
| 20 entities + 40 migrations + clean repo | `validate` exits in < 1000ms | `tests/unit/validate/performance.test.ts` |

If SC-1 fails on the first run, the mitigation per Research §Pitfalls is to enable `jiti({fsCache:true})` for the validate path. The performance test must enforce the 1-second budget; if the budget is exceeded, fail the test and surface the jiti config knob.

### Success Criteria — Documentation Coverage (SC-2)

All 8 rule findings produce distinct, readable error messages naming the offending files. Verified by per-rule unit tests asserting:
- `finding.rule === 'drift-without-migration'` (etc.)
- `finding.message` contains the offending file path
- `finding.fix` contains the recommended next command (e.g., `'create --entity X --name Y'`, `'create --regenerate <id>'`, `'acknowledge-removal X'`)

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/validate/` — new directory
- [ ] `tests/unit/validate/rules/drift-without-migration.test.ts`
- [ ] `tests/unit/validate/rules/version-skew.test.ts`
- [ ] `tests/unit/validate/rules/sequence-gaps.test.ts`
- [ ] `tests/unit/validate/rules/parallel-branch-collision.test.ts`
- [ ] `tests/unit/validate/rules/cross-entity-ordering.test.ts`
- [ ] `tests/unit/validate/rules/removed-entities.test.ts`
- [ ] `tests/unit/validate/rules/reserved-namespace.test.ts`
- [ ] `tests/unit/validate/rules/frozen-snapshot-edited.test.ts`
- [ ] `tests/unit/validate/exit-code.test.ts` — CLI exit-code smoke (VAL-09)
- [ ] `tests/unit/validate/acknowledge-removal.test.ts` — VAL-10
- [ ] `tests/unit/validate/performance.test.ts` — SC-1 < 1s on 20-entity/40-migration fixture
- [ ] `tests/unit/scaffold/regenerate.test.ts` — SCF-08
- [ ] `tests/unit/cli/file-only-commands.test.ts` — CLI-02 `--remote` ignored on FS-only commands
- [ ] `tests/fixtures/validate/` — fixture entities, snapshots, and migration folders for each rule's happy + error paths
- [ ] No new framework install required (jiti, ts-morph, picocolors, cli-table3 all already shipped)

---

## Manual-Only Verifications

*All Phase 7 behaviors have automated verification.*

The README updates required by Phase 7 (`validate`, `create --regenerate`, `acknowledge-removal` documentation) are in scope for the final wave but are doc-only and verified by file diff during code review.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] SC-1 performance budget (< 1s on clean 20-entity/40-migration repo) is enforced by test
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
