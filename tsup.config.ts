import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Options } from 'tsup';

// Phase 1 ships only the library entry. The CLI binary entry
// (`src/cli/index.ts`) is Phase 2 territory; gate it behind a presence check
// so `pnpm build` works during Phase 1 without requiring a stub CLI file.
// `process.cwd()` is safe here because tsup invokes the config from the
// project root; this avoids ESM/CJS `__dirname` ambiguity.
const cliEntryPath = resolve(process.cwd(), 'src/cli/index.ts');
const cliEntryExists = existsSync(cliEntryPath);

const initCommandPath = resolve(process.cwd(), 'src/cli/commands/init.ts');
const baselineCommandPath = resolve(process.cwd(), 'src/cli/commands/baseline.ts');
const createCommandPath = resolve(process.cwd(), 'src/cli/commands/create.ts');

const libraryConfig: Options = {
  // Library: dual ESM + CJS with type declarations.
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  tsconfig: 'tsconfig.build.json',
};

// CLI binary + per-subcommand modules. The bin entry's `tryImportRegistrar`
// helper does a runtime `import('./commands/<name>.js')` against the file
// living next to `dist/cli/index.js`, so each command module needs its own
// emitted artifact at `dist/cli/commands/<name>.js`. Subcommand entries are
// gated behind presence checks so the build still works in earlier-plan
// states (Plan 05 ships the bin without commands; Plan 08 adds init/baseline;
// Plan 09 adds create).
const cliEntries: Record<string, string> = {};
if (cliEntryExists) {
  cliEntries['cli/index'] = 'src/cli/index.ts';
}
if (existsSync(initCommandPath)) {
  cliEntries['cli/commands/init'] = 'src/cli/commands/init.ts';
}
if (existsSync(baselineCommandPath)) {
  cliEntries['cli/commands/baseline'] = 'src/cli/commands/baseline.ts';
}
if (existsSync(createCommandPath)) {
  cliEntries['cli/commands/create'] = 'src/cli/commands/create.ts';
}

const cliConfig: Options = {
  // CLI binary + commands: ESM only, shebang prepended (only the bin entry
  // needs the shebang — tsup's `banner` applies to every emitted file in this
  // config; that's harmless because Node ignores the shebang on `import`ed
  // modules and the commands are only loaded via dynamic import, not run as
  // executables).
  entry: cliEntries,
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: false,
  banner: { js: '#!/usr/bin/env node' },
  splitting: false,
  treeshake: true,
  tsconfig: 'tsconfig.build.json',
};

export default defineConfig(cliEntryExists ? [libraryConfig, cliConfig] : [libraryConfig]);
