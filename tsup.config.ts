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

const cliConfig: Options = {
  // CLI binary: ESM only, shebang prepended, no type declarations needed.
  entry: { 'cli/index': 'src/cli/index.ts' },
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
