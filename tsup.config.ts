import { defineConfig } from 'tsup';

export default defineConfig([
  // Library: dual ESM + CJS with type declarations.
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    tsconfig: 'tsconfig.build.json',
  },
  // CLI binary: ESM only, shebang prepended, no type declarations needed.
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    splitting: false,
    treeshake: true,
    tsconfig: 'tsconfig.build.json',
  },
]);
