import { MIGRATION_STATE_ID, type MigrationsServiceBundle } from '../internal-entities/index.js';

/** Inputs for {@link markFailed}. */
export interface MarkFailedArgs {
  /** The runId whose run is being marked failed. */
  runId: string;
  /**
   * The migration id, if known. Optional because `unlock` calls this verb
   * before reading the lock row in some paths. When provided, the verb also
   * appends `migId` to `_migration_state.failedIds`.
   */
  migId?: string;
  /** The cause; serialized into `_migration_runs.error` as `{code, message}`. */
  cause: unknown;
}

/**
 * Mark the run failed (LCK-10 abort path) — 2-item transactWrite.
 *
 * **Item order (Pitfall #7):**
 * 0. `_migration_state` patch — `lockState='failed'`, `heartbeatAt=now`,
 *    `updatedAt=now`. When `migId` is provided: also `failedIds += migId`.
 *    ConditionExpression: `lockRunId = :runId`.
 * 1. `_migration_runs` patch — `status='failed'`, `completedAt=now`,
 *    `lastHeartbeatAt=now`, `error: {code, message}`.
 *
 * **Cause serialization** ({@link serializeCause}):
 * - `Error` instances: `{code: err.code ?? err.name ?? 'Error', message: err.message}`
 * - Anything else: `{code: 'Unknown', message: String(cause)}`
 *
 * Stack traces are intentionally not stored (T-03-16 disposition). README §9.1
 * notes that internal entities live in the user's table, so PII guidance is
 * the operator's responsibility.
 */
export async function markFailed(service: MigrationsServiceBundle, args: MarkFailedArgs): Promise<void> {
  const now = new Date().toISOString();
  const errorMap = serializeCause(args.cause);

  await service.service.transaction
    .write(({ migrationState, migrationRuns }) => {
      const stateOp = migrationState.patch({ id: MIGRATION_STATE_ID }).set({ lockState: 'failed', heartbeatAt: now, updatedAt: now });
      // Branch on `migId` rather than passing an empty `.add({})` (which
      // ElectroDB rejects as malformed).
      const stateWithAdd = args.migId ? stateOp.add({ failedIds: [args.migId] }) : stateOp;
      return [
        stateWithAdd.where(({ lockRunId }, op) => op.eq(lockRunId, args.runId)).commit(),
        migrationRuns
          .patch({ runId: args.runId })
          .set({
            status: 'failed',
            completedAt: now,
            lastHeartbeatAt: now,
            error: errorMap,
          })
          .commit(),
      ];
    })
    .go();
}

interface ErrorMap {
  code: string;
  message: string;
}

/**
 * Duck-typed serialization. We avoid identity-checks against the global
 * Error class for the same reason we avoid them in the cancellation helpers
 * (Pitfall #15) — under dual-package ESM/CJS loading the same logical class
 * can have two identities. Read `.name`, `.message`, and `.code` directly.
 */
function serializeCause(cause: unknown): ErrorMap {
  if (typeof cause === 'object' && cause !== null) {
    const c = cause as { name?: unknown; message?: unknown; code?: unknown };
    if (typeof c.message === 'string') {
      const codeRaw = c.code;
      const nameRaw = c.name;
      const code = typeof codeRaw === 'string' && codeRaw.length > 0 ? codeRaw : typeof nameRaw === 'string' && nameRaw.length > 0 ? nameRaw : 'Error';
      return { code, message: c.message };
    }
  }
  return { code: 'Unknown', message: String(cause) };
}
