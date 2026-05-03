import { EXIT_CODES } from './output/exit-codes.js';
import { log } from './output/log.js';
import { buildProgram } from './program.js';

/**
 * Bin entry. The `#!/usr/bin/env node` shebang is injected by tsup's
 * `banner.js` at build time so the source file remains a regular ES module
 * (no shebang in source — Pitfall tsup#684).
 *
 * Phase 2 ships the program with the global `--config` flag only. Plan 08
 * (init / baseline) and Plan 09 (create) each export a `registerXxxCommand`
 * function that this entry lazy-imports below — keeping Plan 05 free of any
 * downstream-plan import (FND-06 hygiene). Plan 09 will replace the
 * `.catch(...)` block with a non-catching `await` once the three command
 * modules ship.
 */
type Registrar = (program: import('commander').Command) => void;
type CommandModule<K extends string> = Record<K, Registrar>;

/**
 * Dynamically imports a command module that may not yet exist on disk.
 * The path is built from a non-literal expression so `tsc` does not attempt
 * to resolve it at typecheck time. Returns null on any load failure (e.g.
 * the module file is missing — which is the standalone Plan 05 state).
 */
async function tryImportRegistrar<K extends string>(modulePath: string, exportName: K): Promise<Registrar | null> {
  try {
    // The `as string` strips the literal-type narrowing so tsc treats this
    // as a fully dynamic specifier and does not try to resolve it.
    const mod = (await import(modulePath as string)) as Partial<CommandModule<K>>;
    return mod[exportName] ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [registerInit, registerBaseline, registerCreate] = await Promise.all([
    tryImportRegistrar('./commands/init.js', 'registerInitCommand'),
    tryImportRegistrar('./commands/baseline.js', 'registerBaselineCommand'),
    tryImportRegistrar('./commands/create.js', 'registerCreateCommand'),
  ]);

  // Plans 08 + 09 wire these in; until then the program still parses
  // --version / --help so `node dist/cli/index.js --version` smoke-tests
  // green for FND-04.
  const program = buildProgram({
    ...(registerInit ? { registerInit } : {}),
    ...(registerBaseline ? { registerBaseline } : {}),
    ...(registerCreate ? { registerCreate } : {}),
  });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log.err(message);
  process.exit(EXIT_CODES.USER_ERROR);
});
