import { MIGRATION_STATE_ID, type MigrationStateEntity } from '../entities/migration-state.js';
import { ElectroDBMigrationError } from '../errors.js';
import { isConditionalCheckFailed } from './lock.js';

// Removes one migration id from deploymentBlockedIds. Refuses to run while
// a runner mutex is held (where lockRefId is set) — admin operations should
// not race with active migrations.
//
// Idempotent: if the id is not in the set, the SET DELETE is a no-op for that
// element. The `where` clause is the only thing that can fail, and it fails
// only when a runner is currently active.
export const releaseDeploymentBlock = async (
  state: MigrationStateEntity,
  migrationId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .delete({ deploymentBlockedIds: [migrationId] })
      .set({ updatedAt: now })
      // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
      .where((attr: any, op: any) => op.notExists(attr.lockRefId))
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ElectroDBMigrationError(
        'Cannot release deployment block while a migration runner is active. Wait for it to finish or call forceUnlock.',
      );
    }
    throw err;
  }
};

// Empties deploymentBlockedIds. Same active-runner guard as releaseDeploymentBlock.
//
// Implemented via REMOVE on the attribute (clearing the set is equivalent to
// removing the attribute itself; subsequent reads return undefined which the
// state-row reader normalizes to []).
export const releaseAllDeploymentBlocks = async (state: MigrationStateEntity): Promise<void> => {
  const now = new Date().toISOString();
  try {
    await state
      .update({ id: MIGRATION_STATE_ID })
      .remove(['deploymentBlockedIds'])
      .set({ updatedAt: now })
      // biome-ignore lint/suspicious/noExplicitAny: ElectroDB where-callback typing
      .where((attr: any, op: any) => op.notExists(attr.lockRefId))
      .go();
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ElectroDBMigrationError(
        'Cannot release deployment blocks while a migration runner is active. Wait for it to finish or call forceUnlock.',
      );
    }
    throw err;
  }
};
