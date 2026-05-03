import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('package.json manifest (FND-05)', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    engines: { node: string };
    peerDependencies: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it('engines.node is exactly ">=20.12.0"', () => {
    expect(pkg.engines.node).toBe('>=20.12.0');
  });

  it('electrodb peer dep is ">=3.0.0 <4.0.0"', () => {
    expect(pkg.peerDependencies.electrodb).toBe('>=3.0.0 <4.0.0');
  });

  it('@aws-sdk/client-dynamodb peer dep starts with ">=3.0.0"', () => {
    expect(pkg.peerDependencies['@aws-sdk/client-dynamodb']).toMatch(/^>=3\.0\.0/);
  });

  it('jiti runtime dep is ^2.6 or higher 2.x', () => {
    const range = pkg.dependencies.jiti;
    expect(range).toBeDefined();
    expect(range).toMatch(/^\^2\.[6-9]|^\^2\.\d{2}/);
  });

  it('ts-morph runtime dep is ^25', () => {
    expect(pkg.dependencies['ts-morph']).toMatch(/^\^25/);
  });

  it('commander runtime dep is ^14', () => {
    expect(pkg.dependencies.commander).toMatch(/^\^14/);
  });
});
