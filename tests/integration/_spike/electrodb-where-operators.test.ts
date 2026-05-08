/**
 * Wave 0 spike: records which ElectroDB `where()` operators are usable for the
 * lock-acquire ConditionExpression (RESEARCH Open Question 2 / Assumptions A1, A2).
 *
 * For each candidate operator (`eq`, `notExists`, `lt`, `contains`), construct a
 * `migrationState.patch().where(...)` call against an empty DDB Local table:
 * - If the call succeeds (or fails ONLY with the expected ConditionalCheckFailed
 *   because the row doesn't exist), the operator is USABLE — it survived
 *   ElectroDB's expression compilation and reached DDB.
 * - If the call fails with an ElectroDB validation error (e.g. "Unknown method"),
 *   the operator is UNUSABLE for the acquire path; Plan 03 must fall back to a
 *   raw `UpdateCommand` for the lock row.
 *
 * The outcomes are emitted via `console.log` so the developer running the spike
 * can transcribe them into `03-WAVE0-NOTES.md`. The single `expect()` at the
 * end just guards that the harness ran at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_STATE_ID, createMigrationStateEntity } from '../../../src/internal-entities/migration-state.js';
import { createTestTable, deleteTestTable, isDdbLocalReachable, makeDdbLocalClient, randomTableName, skipMessage } from '../_helpers/index.js';

interface OperatorOutcome {
  usable: boolean;
  error?: string;
}

const isExpectedConditionFailure = (msg: string): boolean => {
  // ElectroDB wraps DynamoDB's `ConditionalCheckFailedException` in a friendlier
  // surface message: `Error thrown by DynamoDB client: "The conditional request failed"`.
  // That is the EXPECTED failure when the operator itself rendered correctly — the
  // row simply isn't present (or the condition doesn't match), which we interpret as
  // "operator usable; condition just didn't match an empty table". An ElectroDB
  // validation failure (e.g. `op.foo` is unknown) would surface a DIFFERENT message
  // shape — no "conditional request" / "ConditionalCheckFailed" tokens.
  return /conditional request failed|ConditionalCheckFailed/i.test(msg);
};

const recordOutcome = async (fn: () => Promise<unknown>): Promise<OperatorOutcome> => {
  try {
    await fn();
    return { usable: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isExpectedConditionFailure(msg)) {
      return { usable: true, error: `(expected condition failure: ${msg})` };
    }
    return { usable: false, error: msg };
  }
};

describe('Wave 0 spike: ElectroDB where() operator coverage (Assumptions A1/A2)', () => {
  const tableName = randomTableName('where-spike');
  const { raw, doc } = makeDdbLocalClient();
  let alive = false;

  beforeAll(async () => {
    alive = await isDdbLocalReachable();
    if (!alive) return;
    await createTestTable(raw, tableName);
  }, 30_000);

  afterAll(async () => {
    if (alive) await deleteTestTable(raw, tableName);
  });

  it('records which op.* helpers are usable; outcome is recorded in 03-WAVE0-NOTES.md', async () => {
    if (!alive) {
      console.warn(skipMessage());
      return;
    }
    const entity = createMigrationStateEntity(doc, tableName);
    const outcomes: Record<string, OperatorOutcome> = {};
    const isoNow = new Date().toISOString();

    // op.eq — equality check on a string attribute
    outcomes.eq = await recordOutcome(async () => {
      await entity
        .patch({ id: MIGRATION_STATE_ID })
        .set({ updatedAt: isoNow })
        .where(({ lockRunId }, op) => op.eq(lockRunId, 'never-matches-anything'))
        .go();
    });

    // op.notExists — attribute_not_exists; the canonical fresh-row predicate
    outcomes.notExists = await recordOutcome(async () => {
      await entity
        .patch({ id: MIGRATION_STATE_ID })
        .set({ updatedAt: isoNow })
        .where(({ lockState }, op) => op.notExists(lockState))
        .go();
    });

    // op.lt — less-than against an ISO-8601 string (used by stale-takeover)
    outcomes.lt = await recordOutcome(async () => {
      await entity
        .patch({ id: MIGRATION_STATE_ID })
        .set({ updatedAt: isoNow })
        .where(({ heartbeatAt }, op) => op.lt(heartbeatAt, '1900-01-01T00:00:00.000Z'))
        .go();
    });

    // op.contains — DDB `contains(name, value)` against a set; this is the membership
    // probe the LCK-05 release-mode handoff uses to test inFlightIds.
    outcomes.contains = await recordOutcome(async () => {
      await entity
        .patch({ id: MIGRATION_STATE_ID })
        .set({ updatedAt: isoNow })
        .where(({ inFlightIds }, op) => op.contains(inFlightIds, 'no-such-id'))
        .go();
    });

    // The spike's purpose is to record outcomes — the assertion is non-functional;
    // it just guards that the harness ran at all. The developer transcribes the
    // console output below into the WAVE0-NOTES table.
    console.log('[Wave 0 spike] ElectroDB op.* outcomes:', JSON.stringify(outcomes, null, 2));
    expect(outcomes.eq).toBeDefined();
    expect(outcomes.notExists).toBeDefined();
    expect(outcomes.lt).toBeDefined();
    expect(outcomes.contains).toBeDefined();
  }, 30_000);
});
