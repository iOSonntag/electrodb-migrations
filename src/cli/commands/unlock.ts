import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { createMigrationsClient } from '../../client/index.js';
import type { LockRowSnapshot } from '../../lock/index.js';
import type { MigrationsServiceBundle } from '../../internal-entities/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createTable } from '../output/table.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

/**
 * Lock states that, when cleared via `unlock`, indicate an in-progress run that needs the
 * `_migrations.status='failed'` patch (OQ2 / BLOCKER 3). `release` is excluded — release-mode
 * is the post-success state and the migration is already `applied`. `failed` is excluded —
 * the migration was already failed (no patch needed). `free` is excluded — nothing to patch.
 */
const ACTIVE_PRIOR_STATES = new Set(['apply', 'rollback', 'finalize', 'dying']);

export interface RunUnlockArgs {
  cwd: string;
  configFlag?: string;
  runId: string;
  yes?: boolean;
}

/**
 * CLI-05 / CLI-06 / CLI-07 — operator-path unlock command.
 *
 * Required: --run-id <runId>. Even with --yes, the runId is required (CLI-05 / CLI-07; commander's
 * .requiredOption enforces this).
 *
 * Always renders the lock-state table to stderr (cli-table3) BEFORE either prompting or executing.
 * Even on --yes, the table is still rendered so the operator's logs have an audit trail (Pitfall 8).
 *
 * **OQ2 / BLOCKER 3 — _migrations.status='failed' patch (load-bearing for VALIDATION invariant 15).**
 * After `client.forceUnlock` returns, when the `priorState` is an active in-progress state
 * (`apply` | `rollback` | `finalize` | `dying`), `runUnlock` patches
 * `_migrations.status='failed'` for `lock.lockMigrationId`. This converges the audit row
 * with the actual table state. The patch is best-effort (.catch) mirroring apply-flow's
 * CR-04 disposition — if the patch fails, the lock is still cleared and the operator sees
 * an error message, but does NOT cause `unlock` to fail.
 *
 * Patch is implemented HERE (in the CLI's runUnlock) rather than inside `client.forceUnlock`
 * to keep the `_migrations` audit-row patching out of the client/lock layers. The CLI is the
 * natural seam: it has the user-facing transaction context. (Future Phase 7 work may move
 * this into `state-mutations/unlock.ts`; for now, it's a focused CLI-layer responsibility.)
 *
 * 4-cell truth table (VALIDATION invariant 15):
 * - apply cleared   → lockState='failed', _migrations.status='failed' (OQ2 patch)
 * - release cleared → lockState='free',   _migrations.status unchanged (no OQ2 patch)
 * - finalize cleared → lockState='failed', _migrations.status='failed' (OQ2 patch)
 * - rollback cleared → lockState='failed', _migrations.status='failed' (OQ2 patch)
 */
export async function runUnlock(args: RunUnlockArgs): Promise<void> {
  const { config } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  const region = config.region;
  const ddb = region !== undefined ? new DynamoDBClient({ region }) : new DynamoDBClient({});

  try {
    const client = createMigrationsClient({ config, client: ddb, cwd: args.cwd });

    const lock = await client.getLockState();
    if (!lock || lock.lockState === 'free') {
      log.info('Lock is already free; nothing to unlock.');
      return;
    }

    // Capture lockMigrationId BEFORE forceUnlock — the post-clear lock row may not have it.
    const priorMigrationId = lock.lockMigrationId;

    // CLI-06 — always render the lock-state table (even with --yes, for audit trail).
    log.info(renderLockTable(lock));

    if (!args.yes) {
      const confirmed = await confirmInteractive(`Unlock runId ${args.runId}?`);
      if (!confirmed) {
        log.info('Aborted.');
        return;
      }
    }

    // Execute: forceUnlock dispatches per LCK-08 truth table (already in the lib).
    // Pass yes: true (the CLI has either confirmed interactively or received --yes; the
    // programmatic API requires explicit `yes: true` per Plan 05-10 BLOCKER 2).
    const result = await client.forceUnlock({ runId: args.runId, yes: true });
    log.info(c.ok(`Lock cleared (priorState='${result.priorState}').`));

    // OQ2 / BLOCKER 3 — patch _migrations.status='failed' for the in-progress migration.
    // Only when priorState was an active state AND we captured a lockMigrationId.
    if (ACTIVE_PRIOR_STATES.has(result.priorState) && priorMigrationId) {
      // Reach into the __bundle internal accessor (non-enumerable property set by Plan 05-10's
      // create-migrations-client.ts). NOT part of the typed MigrationsClient interface.
      const bundle = (client as unknown as { __bundle: MigrationsServiceBundle }).__bundle;
      await bundle.migrations
        .patch({ id: priorMigrationId })
        .set({ status: 'failed' })
        .go()
        .catch((patchErr: unknown) => {
          // Best-effort — mirror apply-flow CR-04 disposition.
          const msg = patchErr instanceof Error ? patchErr.message : String(patchErr);
          // eslint-disable-next-line no-console -- diagnostic; matches apply-flow CR-04
          console.error(
            `[electrodb-migrations] unlock: failed to patch _migrations.status='failed' for '${priorMigrationId}':`,
            msg,
          );
        });
      log.info(
        c.warn(
          `  In-progress migration '${priorMigrationId}' was marked as \`failed\` (status patched). Run \`electrodb-migrations status\` to inspect.`,
        ),
      );
    }
  } finally {
    try {
      ddb.destroy();
    } catch {
      // ignore — destroy() is best-effort.
    }
  }
}

/**
 * CLI-06 prompt rendering — renders the lock-state table to a string.
 *
 * Exported for unit-test golden-file assertion. Each field that VALIDATION
 * invariant 9 pins is rendered as a row: lockState, lockHolder, lockRunId,
 * lockMigrationId, heartbeatAt (with age suffix), elapsed runtime.
 *
 * Pitfall 5 mitigation: a recent heartbeat (< 2 minutes old) is highlighted
 * in yellow so the operator sees a visual cue to reconsider before confirming.
 */
export function renderLockTable(row: LockRowSnapshot): string {
  const elapsedMs = row.lockAcquiredAt ? Date.now() - new Date(row.lockAcquiredAt).getTime() : 0;
  const elapsed = `${Math.floor(elapsedMs / 60000)}m ${Math.floor((elapsedMs % 60000) / 1000)}s`;
  const heartbeatAge = row.heartbeatAt
    ? `${Math.floor((Date.now() - new Date(row.heartbeatAt).getTime()) / 1000)}s ago`
    : '(never)';
  // Highlight recent heartbeat as a warning (Pitfall 5 — operator should reconsider).
  const heartbeatColor =
    row.heartbeatAt && Date.now() - new Date(row.heartbeatAt).getTime() < 2 * 60_000
      ? c.warn
      : (s: string) => s;
  const t = createTable({
    head: ['Field', 'Value'],
    rows: [
      ['lockState', c.warn(row.lockState)],
      ['lockHolder', row.lockHolder ?? '(none)'],
      ['lockRunId', row.lockRunId ?? '(none)'],
      ['lockMigrationId', row.lockMigrationId ?? '(none)'],
      ['heartbeatAt', `${row.heartbeatAt ?? '(never)'} (${heartbeatColor(heartbeatAge)})`],
      ['elapsed runtime', elapsed],
    ],
  });
  return t.toString();
}

/**
 * CLI-06 interactive y/N prompt via node:readline/promises.
 *
 * RESEARCH §line 949-957 canonical readline pattern. Returns true when the
 * operator types 'y' or 'yes' (case-insensitive). Any other response (including
 * empty) is treated as 'n' to fail-safe on the operator's behalf.
 */
async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${prompt} [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Register the `unlock` subcommand. */
export function registerUnlockCommand(program: Command): void {
  program
    .command('unlock')
    .description('Manually clear the migration lock; dispatches per LCK-08 truth table (CLI-05/06/07)')
    .requiredOption('--run-id <runId>', 'The lock holder runId (required even with --yes)')
    .option('--yes', 'Skip the interactive confirmation prompt', false)
    .action(async (opts: { runId: string; yes?: boolean }) => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runUnlock({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
          runId: opts.runId,
          ...(opts.yes ? { yes: true } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
