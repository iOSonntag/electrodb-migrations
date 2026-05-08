/**
 * Cancellation-reason helpers shared by every state-mutations verb.
 *
 * **Pitfall #7 — item-order convention.** AWS SDK v3 throws
 * `TransactionCanceledException` when one or more items in a `TransactWriteItems`
 * call fails its `ConditionExpression`. The exception's `CancellationReasons`
 * array is indexed in the same order as the transactWrite items.
 *
 * Phase 3's `state-mutations/*.ts` verbs ALL follow the convention:
 *
 *   item 0 → `_migration_state` mutation (the lock row)
 *   item 1 → `_migrations` mutation (when present)
 *   item 2 → `_migration_runs` mutation (when present)
 *
 * So `CancellationReasons[0]` is always the lock-row diagnosis. `acquire`,
 * `transitionToReleaseMode`, `clear`, `markFailed`, `appendInFlight`, and
 * `unlock` all rely on this; if a future verb emits items in a different
 * order, this helper will silently mis-attribute the failure.
 *
 * **Detection contract — read the error's `name` field; do NOT regex on its
 * message.** AWS SDK v3 sets `.name = 'TransactionCanceledException'`
 * reliably; the message format is a documentation surface that may change
 * between SDK minor versions. The `is*` helper here therefore reads `.name`.
 * Source: `@aws-sdk/client-dynamodb` `TransactionCanceledException` class.
 *
 * The framework also intentionally avoids identity-checks against the SDK's
 * concrete error classes — under dual ESM/CJS loading the class identity
 * differs across module graphs and the check fails silently. Pitfall #15 /
 * README §9.1.
 */

/** Stable shape returned by {@link extractCancellationReason}. */
export interface CancellationReason {
  /** Always 0 for state-mutations verbs (item-0 convention). */
  index: number;
  /** Cancellation code from DDB. `'ConditionalCheckFailed'` for lock contention. */
  code: string;
  /**
   * The lock-row item carried back via `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`.
   * DDB Local does not always populate this — Assumption A9 in RESEARCH.md.
   * Real AWS DynamoDB does populate it when the verb's commit options request
   * `ALL_OLD`. Callers MUST tolerate `undefined`.
   */
  item?: Record<string, unknown>;
}

/**
 * Internal narrowing for the SDK v3 cancellation shape. We don't use the SDK's
 * own `TransactionCanceledException` class directly because:
 *  - the framework treats errors as duck-typed (Pitfall #15);
 *  - tests should be able to construct cancellation-shaped POJOs without
 *    instantiating SDK classes.
 */
interface MaybeTransactionCancelled {
  name?: string;
  CancellationReasons?: ReadonlyArray<{
    Code?: string;
    Message?: string;
    Item?: Record<string, unknown>;
  }>;
}

/**
 * Returns true iff `err` is a `TransactionCanceledException` whose **first**
 * cancellation reason is `'ConditionalCheckFailed'`. Item 0 is the lock-row
 * mutation in every state-mutations verb (Pitfall #7).
 *
 * Detection uses `err.name` (the SDK contract) — never regex on `err.message`.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as MaybeTransactionCancelled;
  if (e.name !== 'TransactionCanceledException') return false;
  const reasons = e.CancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  return reasons[0]?.Code === 'ConditionalCheckFailed';
}

/**
 * Extract item-0's cancellation reason. Returns `null` if the error has no
 * `CancellationReasons` (i.e. is not a TransactionCanceledException). The
 * `item` field carries `ALL_OLD` when DDB supplies it.
 *
 * **Note** — does NOT require `name === 'TransactionCanceledException'`. Some
 * SDK paths (and DDB Local) attach `CancellationReasons` to errors with
 * different `name` values; this helper extracts the diagnosis whenever the
 * reasons array is present, leaving the `name` check to
 * {@link isConditionalCheckFailed}.
 */
export function extractCancellationReason(err: unknown): CancellationReason | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as MaybeTransactionCancelled;
  if (!Array.isArray(e.CancellationReasons) || e.CancellationReasons.length === 0) return null;
  const r = e.CancellationReasons[0];
  if (!r) return null;
  return {
    index: 0,
    code: r.Code ?? 'Unknown',
    item: r.Item,
  };
}

/**
 * Shape of `service.transaction.write(...).go()` in ElectroDB v3 — does NOT
 * throw on cancellation; returns `{canceled: true, data: [{rejected, code, item, message}]}`.
 * Per-item rejections include the lock-row diagnosis at index 0 (Pitfall #7).
 */
export interface TransactionWriteResult {
  canceled: boolean;
  data?: ReadonlyArray<{
    rejected?: boolean;
    code?: string;
    message?: string;
    item?: Record<string, unknown> | null;
  }>;
}

/**
 * Returns true iff the ElectroDB transactWrite result reports ANY item was
 * rejected by `ConditionalCheckFailed`. ElectroDB v3 intercepts AWS SDK's
 * `TransactionCanceledException` and surfaces it as `{canceled: true, data:
 * [...]}` — DDB reports a per-item rejection map, so cancellation can be
 * rooted at item 1 or 2 of a multi-item transactWrite (e.g. a `migrations`
 * patch failing because the row does not exist) while item 0 is reported as
 * `None`. Every verb must scan all items rather than just data[0].
 */
export function isResultConditionalCheckFailed(result: TransactionWriteResult): boolean {
  if (!result.canceled) return false;
  if (!Array.isArray(result.data)) return false;
  return result.data.some((d) => d?.rejected === true && d.code === 'ConditionalCheckFailed');
}

/**
 * Extract the FIRST cancellation reason from the ElectroDB transactWrite
 * result. By Pitfall #7 convention, item 0 is the lock-row mutation when
 * present, so its diagnosis (current holder via `ALL_OLD`) is preferred.
 * If item 0 succeeded but a later item failed, the helper returns that item's
 * reason with the `index` field reflecting the actual position. Mirrors
 * {@link extractCancellationReason} but for the `{canceled, data}` shape.
 */
export function extractResultCancellationReason(result: TransactionWriteResult): CancellationReason | null {
  if (!result.canceled || !Array.isArray(result.data)) return null;
  const idx = result.data.findIndex((d) => d?.rejected === true);
  if (idx < 0) return null;
  const item = result.data[idx];
  if (!item) return null;
  const reason: CancellationReason = {
    index: idx,
    code: item.code ?? 'Unknown',
  };
  if (item.item) reason.item = item.item;
  return reason;
}
