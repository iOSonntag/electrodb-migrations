import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../');

describe('CLI bin manifest (FND-04)', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };

  it('package.json bin["electrodb-migrations"] points to ./dist/cli/index.js', () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin?.['electrodb-migrations']).toBe('./dist/cli/index.js');
  });

  it('src/cli/index.ts exists and references buildProgram + parseAsync', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/cli/index.ts'), 'utf8');
    expect(src).toContain('buildProgram');
    expect(src).toContain('parseAsync');
  });

  it('src/cli/index.ts wires the top-level error handler through log.err + EXIT_CODES', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/cli/index.ts'), 'utf8');
    expect(src).toContain('log.err');
    expect(src).toContain('EXIT_CODES');
  });

  it('if dist/cli/index.js exists, its first line is the Node shebang', () => {
    const dist = resolve(REPO_ROOT, 'dist/cli/index.js');
    if (!existsSync(dist)) {
      // pnpm build has not run yet; the FND-04 contract is satisfied by the
      // static source assertions above. The build smoke is left to the
      // top-level success-criteria check after Task 3 completes.
      return;
    }
    const firstLine = readFileSync(dist, 'utf8').split('\n', 1)[0] ?? '';
    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
