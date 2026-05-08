---
phase: 04-apply-release-finalize-runner
plan: "06"
subsystem: runner/output-formatters
tags:
  - runner
  - cli-output
  - tdd
  - phase-04
  - wave-1
dependency_graph:
  requires:
    - src/internal-entities/migrations.ts  # HistoryRow shape parity
  provides:
    - src/runner/apply-summary.ts          # renderApplySummary (RUN-09)
    - src/runner/history-format.ts         # formatHistoryJson (CLI-04)
  affects:
    - Plan 12 (apply CLI command — consumes renderApplySummary)
    - Plan 13 (history CLI command — consumes formatHistoryJson)
tech_stack:
  added: []
  patterns:
    - TDD RED→GREEN with inline snapshots pinning exact output bytes
    - Pure formatter modules (zero runtime deps, no picocolors)
    - Set→sorted-array normalization for byte-stable JSON output
key_files:
  created:
    - src/runner/apply-summary.ts
    - src/runner/history-format.ts
    - tests/unit/runner/apply-summary.test.ts
    - tests/unit/runner/history-format.test.ts
  modified: []
decisions:
  - "Open Question 5 resolved: formatHistoryJson returns a top-level array (no envelope), ISO-8601 dates verbatim, reads Set converted to sorted string array"
  - "renderApplySummary is color-free; CLI command (Plan 12) applies picocolors wrapping to headline"
  - "Both formatters are pure functions with zero runtime dependencies"
metrics:
  duration: "~3 minutes"
  completed: "2026-05-08"
  tasks_completed: 4
  files_created: 4
  files_modified: 0
---

# Phase 4 Plan 06: Apply Summary + History JSON Formatters Summary

Two pure formatter modules — `renderApplySummary` (RUN-09 apply success text pinned byte-equal to README §4 format) and `formatHistoryJson` (CLI-04 stable JSON contract with Set→sorted-array normalization) — built via TDD with inline snapshots.

## Pinned Apply Summary Output

The inline snapshot for `renderApplySummary` (AS-1, single migration, 12.3s elapsed):

```
\nApplied 1 migration in 12.3s.\n  • 20260601-User-add-status (User v1→v2): 1000 scanned, 1000 migrated, 0 skipped, 0 failed\n\nNext steps:\n  1. Run `electrodb-migrations release` after deploying the new code\n  2. After bake-in, run `electrodb-migrations finalize <id>` to delete v1 records\n
```

The template structure:
- Blank leading line
- `Applied N migration[s] in X.Xs.` headline (ms for sub-second elapsed)
- Per-migration bullets: `  • <id> (<entityName> v<from>→v<to>): <scanned> scanned, <migrated> migrated, <skipped> skipped, <failed> failed`
- Blank separator
- `Next steps:` header
- `  1. Run \`electrodb-migrations release\` after deploying the new code`
- `  2. After bake-in, run \`electrodb-migrations finalize <id>\` to delete v1 records`
- Blank trailing line

**README §4 step 6 parity:** README §4 describes `apply` at a high level but does not contain a verbatim success template. The plan's draft template (from the `<readme_excerpt>`) is authoritative. The inline snapshot IS the living contract — any future README update to include this output should match the snapshot byte-for-byte.

## History Format Test Names

The 6 test cases for `formatHistoryJson`:

1. `HF-1: empty input returns top-level array with trailing newline`
2. `HF-2: single row returns pretty-printed JSON with 2-space indent`
3. `HF-3: Set<string> reads are converted to sorted string array`
4. `HF-4: date fields are kept as ISO-8601 strings verbatim (no epoch conversion)`
5. `HF-5: rows are sorted by id ascending regardless of input order`
6. `HF-6: entity filter option limits output to matching entityName rows`

## README §4 Step 6 Alignment

The README's `### 6. Apply` section (lines 124–130) describes the command semantics but does not include a verbatim success output template. The formatter's output format follows the plan's `<readme_excerpt>` template exactly. The inline snapshot in `tests/unit/runner/apply-summary.test.ts` pins this format — any deviation between code and documentation is visible as a test diff.

## TDD Gate Compliance

Four commits in RED→GREEN sequence:

1. `test(04-06a): RED — apply summary text (RUN-09)` — module-not-found confirms RED gate
2. `feat(04-06a): GREEN — apply summary text (RUN-09)` — 6/6 tests pass
3. `test(04-06b): RED — history JSON shape (CLI-04)` — module-not-found confirms RED gate
4. `feat(04-06b): GREEN — history JSON shape (CLI-04)` — 6/6 tests pass (includes snapshot escaping fix)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed inline snapshot escaping in history-format test**
- **Found during:** GREEN phase of history-format
- **Issue:** Test file used `\"` (escaped quotes inside template literal) which vitest doesn't accept — it expects unescaped `"` inside `toMatchInlineSnapshot` template literals
- **Fix:** Replaced `\\"key\\"` with `"key"` throughout the HF-2 snapshot
- **Files modified:** `tests/unit/runner/history-format.test.ts`
- **Commit:** 3670def (combined with GREEN implementation)

## Known Stubs

None. Both formatters are complete implementations with no placeholder values.

## Threat Flags

None. Both formatters are read-only pure functions with no new network endpoints, auth paths, or file access.

## Self-Check: PASSED

- [x] `src/runner/apply-summary.ts` exists (61 lines, <80)
- [x] `src/runner/history-format.ts` exists (74 lines, <80)
- [x] `tests/unit/runner/apply-summary.test.ts` exists
- [x] `tests/unit/runner/history-format.test.ts` exists
- [x] 4 commits: d65ccfe, d2f38ed, 2c95c68, 3670def
- [x] All 12 tests pass (6 AS-* + 6 HF-*)
- [x] `pnpm tsc --noEmit` exits 0
- [x] `grep "Run \`electrodb-migrations release\`" src/runner/apply-summary.ts` returns 1 hit
- [x] `grep "JSON.stringify.*null, 2" src/runner/history-format.ts` returns 1 hit
- [x] Neither formatter imports picocolors
