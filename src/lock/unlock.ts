import type { MigrationsServiceBundle } from '../internal-entities/index.js';
import { type UnlockResult, unlock as unlockMutation } from '../state-mutations/index.js';

/**
 * Operator-path forced clear (LCK-08). Thin orchestrator over
 * {@link unlockMutation `state-mutations.unlock`} so the Phase 5 CLI command
 * (`unlock --run-id <id>` / CLI-05/06/07) can wrap a stable runtime entry
 * point.
 *
 * The state-mutations verb already performs the LCK-08 truth-table dispatch
 * (read with `consistent: CONSISTENT_READ` → mark failed for active states,
 * forced clear for `release`/`failed`, no-op for `free`); this file does NOT
 * re-implement that logic. Intentional: keeps the LCK-08 semantics in exactly
 * one place (the verb) so a documentation drift between orchestrator and verb
 * is impossible.
 */
export async function forceUnlock(service: MigrationsServiceBundle, args: { runId: string }): Promise<UnlockResult> {
  return unlockMutation(service, args);
}
