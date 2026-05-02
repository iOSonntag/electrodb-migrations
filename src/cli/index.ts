import { Command } from 'commander';
import { register as registerAccept } from './commands/accept.js';
import { register as registerApply } from './commands/apply.js';
import { register as registerBaseline } from './commands/baseline.js';
import { register as registerCreate } from './commands/create.js';
import { register as registerDiff } from './commands/diff.js';
import { register as registerFinalize } from './commands/finalize.js';
import { register as registerInit } from './commands/init.js';
import { register as registerPlan } from './commands/plan.js';
import { register as registerReconcileState } from './commands/reconcile-state.js';
import { register as registerRelease } from './commands/release.js';
import { register as registerRollback } from './commands/rollback.js';
import { register as registerStatus } from './commands/status.js';

const program = new Command();

program
  .name('electrodb-migrations')
  .description('First-class migration system for ElectroDB')
  .version('0.0.1');

registerInit(program);
registerBaseline(program);
registerStatus(program);
registerDiff(program);
registerCreate(program);
registerPlan(program);
registerApply(program);
registerFinalize(program);
registerRollback(program);
registerRelease(program);
registerReconcileState(program);
registerAccept(program);

program.parse();
