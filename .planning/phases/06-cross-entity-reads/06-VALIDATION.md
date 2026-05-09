---
phase: 6
slug: cross-entity-reads
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-09
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: `06-RESEARCH.md` §Validation Architecture (line 692).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.x (verified in package.json) |
| **Config files** | `vitest.config.ts` (unit) + `vitest.integration.config.ts` (integration) — both ship from prior phases |
| **Quick run command** | `pnpm vitest run` |
| **Full suite command** | `pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts` |
| **Estimated runtime** | ~30s unit / ~120s full (DDB Local in-memory) |
| **Phase 5 baseline** | 957 unit + 41 Phase-5 integration green; 2 pre-existing failures (DI-04-15-01/02) carried as known warnings |

---

## Sampling Rate

- **After every task commit:** Run `pnpm vitest run` (unit suite — ≤30s feedback)
- **After every plan wave:** Run `pnpm vitest run && pnpm vitest run --config vitest.integration.config.ts` (~120s)
- **Before `/gsd-verify-work`:** Full suite must be green (Phase-6-attributable failures = 0)
- **Max feedback latency:** 30 seconds (unit), 120 seconds (full)

---

## Per-Task Verification Map

> Tasks are placeholders — exact `task_id` values land when `gsd-planner` writes PLAN.md files. Each plan must wire its tasks to one of the rows below.

| Requirement | Test Type | Automated Command | Status |
|-------------|-----------|-------------------|--------|
| **CTX-01** — `up()`/`down()` receive `ctx` second arg | unit | `pnpm vitest run tests/unit/ctx/build-ctx.test.ts` | ⬜ Wave 0 |
| **CTX-02** — `ctx.entity(Other)` returns facade bound to unguarded client | unit + integration | `pnpm vitest run tests/unit/ctx/read-only-facade.test.ts` + `pnpm vitest run --config vitest.integration.config.ts tests/integration/ctx/ctx-read.test.ts` | ⬜ Wave 0 |
| **CTX-03** — Write methods on facade throw before DDB | unit | `pnpm vitest run tests/unit/ctx/read-only-facade.test.ts -t "writes throw"` | ⬜ Wave 0 |
| **CTX-04** — `ctx.entity(SelfEntity)` throws `EDBSelfReadInMigrationError` before DDB | unit | `pnpm vitest run tests/unit/ctx/build-ctx.test.ts -t "self-read"` | ⬜ Wave 0 |
| **CTX-05** — Fingerprint mismatch throws `EDBStaleEntityReadError` | unit + integration | `pnpm vitest run tests/unit/ctx/build-ctx.test.ts -t "stale"` + `pnpm vitest run --config vitest.integration.config.ts tests/integration/ctx/ctx-read.test.ts -t "out-of-bounds"` | ⬜ Wave 0 |
| **CTX-06** — `defineMigration({reads})` persisted on `_migrations.reads` | integration | `pnpm vitest run --config vitest.integration.config.ts tests/integration/ctx/ctx-audit-row.test.ts` | ⬜ Wave 0 |
| **CTX-07** — `validate` refuses ordering violations | — | (Phase 7 scope; data shape only in Phase 6) | — |
| **CTX-08** — Rollback refused when reads-target has later applied migration | unit + integration | `pnpm vitest run tests/unit/rollback/preconditions-ctx08.test.ts` + `pnpm vitest run --config vitest.integration.config.ts tests/integration/rollback/ctx08-refusal.test.ts` | ⬜ Wave 0 |

### Success Criteria — Integration Coverage Matrix (SC-5)

The four declared/undeclared × in-bounds/out-of-bounds cells:

| Case | Description | Expected | Test |
|------|-------------|----------|------|
| declared + in-bounds | `reads:[Team]`, snapshot matches | read succeeds | `ctx-read.test.ts` "declared in-bounds" |
| declared + out-of-bounds | `reads:[Team]`, snapshot mismatch (older) | `buildCtx` throws `EDBStaleEntityReadError` | `ctx-read.test.ts` "declared out-of-bounds" |
| undeclared + in-bounds | no `reads`, snapshot matches | lazy validation passes | `ctx-read.test.ts` "undeclared in-bounds" |
| undeclared + out-of-bounds | no `reads`, snapshot mismatch | `ctx.entity(Y)` throws `EDBStaleEntityReadError` at first call | `ctx-read.test.ts` "undeclared out-of-bounds" |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/unit/ctx/build-ctx.test.ts` — covers CTX-01, CTX-04, CTX-05 unit scenarios
- [ ] `tests/unit/ctx/read-only-facade.test.ts` — covers CTX-02, CTX-03 unit scenarios
- [ ] `tests/unit/ctx/_helpers.ts` — shared fixture builders (mock unguarded client; in-memory snapshot dir)
- [ ] `tests/unit/rollback/preconditions-ctx08.test.ts` — covers CTX-08 unit scenarios (extends Phase 5 preconditions stub)
- [ ] `tests/integration/ctx/ctx-read.test.ts` — covers SC-1, SC-2, SC-5 integration (4-cell matrix)
- [ ] `tests/integration/ctx/ctx-audit-row.test.ts` — covers CTX-06, SC-4 integration
- [ ] `tests/integration/rollback/ctx08-refusal.test.ts` — covers CTX-08 integration
- [ ] `tests/_helpers/sample-migrations/User-reads-Team/` — fixture migration declaring `reads:[Team]` and using `ctx.entity(Team).get(...)` in `up()`
- [ ] `tests/_helpers/sample-migrations/User-self-read/` — fixture that wrongly does `ctx.entity(User)` from inside a User migration (CTX-04 trigger)
- [ ] **Spike test:** verify `new Entity(entity.schema, { client, table })` produces a functional clone (Research §A4 high-risk assumption)
- [ ] Framework install: no new packages needed

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

The README §Cross-entity reads section update is in scope for Phase 6 but is doc-only and verified by file diff during code review.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (unit) / 120s (full)
- [ ] `nyquist_compliant: true` set in frontmatter
- [ ] Wave 0 spike test for `new Entity(schema, config)` clone passes BEFORE Wave 1 starts

**Approval:** pending
