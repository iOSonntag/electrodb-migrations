# Phase 3 — Wave 0 Decisions

> Recorded: 2026-05-08. These outcomes are inputs to Plans 02–08.
>
> Source spike tests under `tests/integration/_spike/`:
> - `eventual-consistency-prototype.test.ts`
> - `electrodb-where-operators.test.ts`

## Decision A7 — GRD-04 vs README §1 finalize-gating contradiction

**Outcome: README WINS.**

The guard's `GATING_LOCK_STATES` constant in `src/guard/lock-state-set.ts` (Plan 05) **must exclude `'finalize'`**. The set is:

```
{ 'apply', 'rollback', 'release', 'failed', 'dying' }
```

**Rationale (from RESEARCH.md A7 + CLAUDE.md DST-01 "README is the documentation contract"):**
- README §1 (line 248–265 in current README, table at line 259) is explicit: maintenance mode `yes` blocks concurrent runners but `no` does NOT gate app traffic.
- Maintenance mode is held by `finalize` while v1 records are being deleted. The table is in a v2-only steady state by this point — there is no schema mismatch a guarded read or write could hit.
- Finalize can be deferred for weeks; gating app traffic for it would defeat the reason maintenance mode exists.
- REQUIREMENTS.md GRD-04 lists `finalize` in the gating set; this is a documentation defect that will be corrected in Phase 7's `validate` checklist or in a follow-on quick task. **Phase 3 commits MUST NOT silently rewrite REQUIREMENTS.md GRD-04 wording** — the contradiction is logged here for an explicit retrospective resolution.

**Implementation contract for Plan 05:**
- `tests/unit/guard/lock-state-set.test.ts` snapshot test asserts the set has exactly 5 members and excludes `'finalize'`.
- The `lock-state-set.ts` JSDoc references this WAVE0-NOTES decision and links to README §1.

---

## Decision A1/A2 — ElectroDB `where()` operator coverage for the lock-acquire ConditionExpression

**Outcome: ALL FOUR CANDIDATE OPERATORS ARE USABLE.**

Verified by `tests/integration/_spike/electrodb-where-operators.test.ts` against `electrodb@3.7.5` and `amazon/dynamodb-local:latest` on 2026-05-08.

| Operator | Usable? | Notes |
|----------|---------|-------|
| `op.eq(attr, val)` | **true** | Reached DDB; rendered as `name = value`. The patch failed with the expected `"The conditional request failed"` because the row didn't exist, which is the operator-usable signal. |
| `op.notExists(attr)` | **true** | Reached DDB; rendered as `attribute_not_exists(name)`. Same expected condition failure on an empty table. |
| `op.contains(attr, val)` | **true** | Reached DDB; rendered as `contains(name, value)`. Note: the `contains` template takes a single value (not a list); the IN-clause syntax `op.contains([list], attr)` from RESEARCH lines 397–403 is NOT how ElectroDB exposes it — but the membership probe `op.contains(setAttr, valueElement)` works for the LCK-05 `inFlightIds` test path. |
| `op.lt(attr, val)` | **true** | Reached DDB; rendered as `name < value`. Works against ISO-8601 strings (which DDB compares lexicographically — correct for `heartbeatAt` stale-takeover predicates). |

**Implementation contract for Plan 03:**
- The lock-row acquire `state-mutations/acquire.ts` follows the ElectroDB-native shape from PATTERNS.md lines 364–404 verbatim — **no raw `UpdateCommand` fallback is needed.**
- For the LCK-05 release-mode-handoff `inFlightIds` membership test, use `op.contains(inFlightIds, migId)` (single-value form), not the bracketed-list form sketched in RESEARCH.

**Source verification:** `.research/electrodb/src/filterOperations.js` lines 1–120 confirms the operator templates (`eq`, `notExists`, `lt`, `contains` are all present and stable).

---

## Decision A8 — Eventual-consistency simulator return shape

**Outcome: VERIFIED — but the synthesized response requires `$metadata` on both `output` and `response`.**

Verified by `tests/integration/_spike/eventual-consistency-prototype.test.ts` on 2026-05-08 against `@aws-sdk/client-dynamodb@3.x` and `@smithy/middleware-retry@4.5.7`.

**Required shape:**

```typescript
return {
  output: {
    Item: previousState,
    $metadata: { attempts: 0, totalRetryDelay: 0 },
  },
  response: { $metadata: { attempts: 0, totalRetryDelay: 0 } },
} as never;
```

**Why `$metadata` is mandatory:**
The retry middleware (`@smithy/middleware-retry`) sits later in the stack than `finalizeRequest` and tries to set `response.$metadata.attempts = N` after the inner handler returns. If `$metadata` is undefined, the assignment crashes:

```
TypeError: Cannot set properties of undefined (setting 'attempts')
```

The original sketch in PATTERNS.md (lines 1003–1004) and RESEARCH.md Code Example 6 used `response: { /* synthesized */ }` and `output: previousState` — both are insufficient. The Wave 0 spike caught this.

**Implementation contract for Plan 07:**
- All BLD-04 integration tests use `attachEventualConsistencyMiddleware` from `tests/integration/_helpers/eventual-consistency.ts`.
- Tests exercise BOTH paths: (a) `ConsistentRead` unset returns simulated `lockState='free'` → guard wrongly passes the call; (b) `ConsistentRead: true` returns real `lockState='apply'` → guard correctly throws.
- The simulator does NOT need to synthesize HTTP headers or full smithy `HttpResponse` shape — `$metadata` on `output` and `response` is sufficient at step `'finalizeRequest'`.

---

## Wave 0 Sign-Off

- [x] Helpers landed (Task 1 of Plan 03-01) — commit `f217973`
- [x] Simulator prototype green on DDB Local (Task 2 of Plan 03-01) — `eventual-consistency-prototype.test.ts` passes
- [x] ElectroDB operator spike outcome recorded above — all four operators usable; ElectroDB-native acquire path locked in
- [x] A7 decision recorded above — README wins; `GATING_LOCK_STATES` excludes `'finalize'`
