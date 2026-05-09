/**
 * Snapshot rollback strategy executor (RBK-06).
 *
 * **Strategy semantics:**
 *   - Type A: KEEP — no DDB write (original v1 retained)     → audit.incrementSkipped()
 *   - Type B: DELETE v2 — DATA LOSS (fresh v2 record gone)   → audit.addDeleted(1) after flush
 *   - Type C: KEEP — no DDB write (resurrects app-deleted v1) → audit.incrementSkipped()
 *
 * **Why snapshot exists:** the user has no `down()` function (they chose this
 * strategy knowing they accept data loss for Type B records). This is the
 * ONLY strategy in the framework that is explicitly DATA-LOSS-bearing.
 * Reference: RESEARCH §Section 4 lines 1188-1198, README §2.2.2.
 *
 * **Pitfall 8 (DATA-LOSS warning surfacing):** Even when `--yes` is supplied,
 * the strategy emits a multi-line warning to `stderr` BEFORE executing any DDB
 * writes. This gives the operator's CI logs an audit trail. When `--yes` is
 * absent, the operator must confirm interactively; declining aborts cleanly
 * without DDB writes.
 *
 * **User-aborted return contract:** `executeSnapshot` returns `undefined` on
 * operator abort (user typed N). The orchestrator (Plan 05-09) commits a
 * clean `transitionToReleaseMode(outcome='reverted', rollbackStrategy='snapshot')`
 * with all-skipped audit. This is intentional: return cleanly rather than
 * throwing a cancellation error, keeping the orchestrator's control flow simple.
 *
 * **Algorithm (single-pass with buffer — RESEARCH OQ3 disposition):**
 * 1. Consume the classifier ONCE into type-keyed buffers (aBuffer, bBuffer, cBuffer).
 * 2. Compute counts: a, b, c.
 * 3. If b === 0 AND c === 0: skip the prompt/warning entirely (no DATA LOSS).
 * 4. Otherwise: emit the warning to `stderr`. If `!yes`: prompt operator;
 *    if declined: fill the audit with all-scanned/all-skipped and return.
 * 5. Execute: increment audit per entry; flush v2Deletes for Type B records.
 *
 * @module src/rollback/strategies/snapshot.ts
 * @requires RBK-06
 * @see Pitfall 8 (RESEARCH §lines 675-688)
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AnyElectroEntity, Migration } from '../../migrations/types.js';
import type { RollbackAudit } from '../audit.js';
import { batchFlushRollback } from '../batch-flush-rollback.js';
import type { TypeTableEntry } from '../type-table.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Arguments for `executeSnapshot`.
 *
 * The `io` field provides an injection point for deterministic unit tests:
 *   - `io.stderr` replaces `process.stderr` for warning output.
 *   - `io.confirm` replaces the `node:readline/promises` prompt call.
 *     Receives the prompt string and returns a `Promise<boolean>`.
 *     Production fallback (when `io.confirm` is absent): uses `defaultConfirm`
 *     which opens a readline interface on stdin/stderr.
 *
 * This injection design keeps production code unaware of vitest while enabling
 * byte-exact assertion of the warning text and the prompt-called-once invariant.
 */
export interface ExecuteSnapshotArgs {
  /** Async generator yielding classified type-table entries (from `classifyTypeTable`). */
  classify: AsyncGenerator<TypeTableEntry>;
  /** The migration being rolled back. Snapshot does NOT require `migration.down`. */
  migration: Migration<AnyElectroEntity, AnyElectroEntity>;
  /** DynamoDB DocumentClient for batch write operations. */
  client: DynamoDBDocumentClient;
  /** Target DynamoDB table name. */
  tableName: string;
  /** RBK-12 audit accumulator — receives `scanned`, `skipped`, and `deleted` increments. */
  audit: RollbackAudit;
  /**
   * If `true`, skip the interactive y/N prompt. The DATA-LOSS warning is STILL
   * emitted to `stderr` as an operator audit trail (Pitfall 8).
   */
  yes?: boolean;
  /**
   * Optional I/O injection for testing. Production fallback for each field:
   *   - `stderr`: `process.stderr`
   *   - `confirm`: `defaultConfirm` (uses `node:readline/promises`)
   */
  io?: {
    /** Replace `process.stderr` for warning writes. */
    stderr?: { write: (s: string) => boolean };
    /**
     * Replace the readline.question-based confirmation.
     * Receives the prompt string; returns `Promise<boolean>`.
     * Production uses `defaultConfirm` when this is absent.
     */
    confirm?: (prompt: string) => Promise<boolean>;
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the multi-line warning message for operator visibility (Pitfall 8).
 *
 * The message is intentionally plain text (no ANSI color) — colorization
 * is the CLI layer's responsibility (Plan 05-11). This keeps `src/rollback/`
 * decoupled from `src/cli/`.
 *
 * Format matches RESEARCH §Section 7 lines 1383-1391 verbatim.
 */
function buildWarningMessage(a: number, b: number, c: number): string {
  return (
    `\nStrategy 'snapshot' will:\n` +
    `  - Delete ${b} fresh v2 records (Type B) — DATA LOSS\n` +
    `  - Resurrect ${c} app-deleted records (Type C)\n` +
    `  - Keep ${a} original v1 records (Type A)\n`
  );
}

/**
 * Production confirmation helper using `node:readline/promises`.
 *
 * Receives the prompt string (already includes [y/N] suffix) and returns
 * a boolean based on whether the operator typed 'y' or 'yes'.
 *
 * Node ≥18.7 ships `readline/promises`; project floor is `>=20.12.0`.
 */
async function defaultConfirm(prompt: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${prompt} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Strategy executor
// ---------------------------------------------------------------------------

/**
 * Execute the `snapshot` rollback strategy for the given classifier output.
 *
 * See module JSDoc for full algorithm, DATA-LOSS semantics, and Pitfall 8 details.
 *
 * @param args - See {@link ExecuteSnapshotArgs}.
 * @returns `Promise<void>` — resolves on success OR operator abort (clean return).
 */
export async function executeSnapshot(args: ExecuteSnapshotArgs): Promise<void> {
  const { classify, migration, client, tableName, audit, yes = false, io = {} } = args;

  const stderr = io.stderr ?? process.stderr;
  const confirm = io.confirm ?? defaultConfirm;

  // -------------------------------------------------------------------------
  // Step 1: Single-pass buffer (RESEARCH OQ3 disposition).
  //   Consume the entire classifier into type-keyed arrays.
  //   Do NOT increment audit here — audit pairing happens in Step 4.
  // -------------------------------------------------------------------------
  const aBuffer: TypeTableEntry[] = [];
  const bBuffer: TypeTableEntry[] = [];
  const cBuffer: TypeTableEntry[] = [];

  for await (const entry of classify) {
    if (entry.type === 'A') {
      aBuffer.push(entry);
    } else if (entry.type === 'B') {
      bBuffer.push(entry);
    } else {
      cBuffer.push(entry);
    }
  }

  const a = aBuffer.length;
  const b = bBuffer.length;
  const c = cBuffer.length;

  // -------------------------------------------------------------------------
  // Step 2: Early exit when there is nothing DATA-LOSS-bearing.
  //   If b === 0 AND c === 0, skip the warning/prompt entirely (no data loss).
  // -------------------------------------------------------------------------
  if (b === 0 && c === 0) {
    // No TYPE B or TYPE C — no prompt needed. Proceed directly to audit.
    for (let i = 0; i < a; i++) {
      audit.incrementScanned();
      audit.incrementSkipped();
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Step 3: Emit DATA-LOSS warning (Pitfall 8 — always, even with --yes).
  // -------------------------------------------------------------------------
  stderr.write(buildWarningMessage(a, b, c));

  if (!yes) {
    // Interactive path: prompt operator and abort on N.
    const proceed = await confirm("Proceed? [y/N]");
    if (!proceed) {
      // Operator declined. Fill audit with all-scanned/all-skipped (no DDB writes).
      // The orchestrator commits a clean transitionToReleaseMode with all-skipped audit.
      // See module JSDoc: "return cleanly; the orchestrator commits a clean
      // transitionToReleaseMode with all-skipped audit."
      for (let i = 0; i < a + b + c; i++) {
        audit.incrementScanned();
        audit.incrementSkipped();
      }
      return;
    }
  } else {
    // --yes path: emit audit-trail line to stderr confirming bypass.
    stderr.write('Proceeding because --yes was supplied.\n');
  }

  // -------------------------------------------------------------------------
  // Step 4: Execution — emit per-type audit increments and build v2Deletes.
  // -------------------------------------------------------------------------
  const v2Deletes: Record<string, unknown>[] = [];

  for (const _entry of aBuffer) {
    audit.incrementScanned();
    audit.incrementSkipped(); // Type A: keep — no DDB write
  }

  for (const entry of bBuffer) {
    audit.incrementScanned();
    v2Deletes.push(entry.v2!); // Type B: queue for deletion — DATA LOSS
  }

  for (const _entry of cBuffer) {
    audit.incrementScanned();
    audit.incrementSkipped(); // Type C: keep (resurrection) — no DDB write
  }

  // -------------------------------------------------------------------------
  // Step 5: Flush v2 deletes in a single heterogeneous batch.
  // -------------------------------------------------------------------------
  if (v2Deletes.length > 0) {
    await batchFlushRollback({
      migration,
      client,
      tableName,
      v2Deletes,
    });
    audit.addDeleted(v2Deletes.length);
  }
}
