import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { c, type Colorizer } from '../../../../src/cli/output/colors.js';

const ORIGINAL_FORCE_COLOR = process.env.FORCE_COLOR;

describe('colors.ts (CLI-08)', () => {
  beforeEach(() => {
    // Force ANSI on so output is deterministic across CI / local TTYs.
    process.env.FORCE_COLOR = '1';
  });

  afterEach(() => {
    if (ORIGINAL_FORCE_COLOR === undefined) {
      delete process.env.FORCE_COLOR;
    } else {
      process.env.FORCE_COLOR = ORIGINAL_FORCE_COLOR;
    }
  });

  it('exports the five Colorizer methods (ok / warn / err / dim / bold)', () => {
    const required: Array<keyof Colorizer> = ['ok', 'warn', 'err', 'dim', 'bold'];
    for (const key of required) {
      expect(typeof c[key]).toBe('function');
    }
  });

  it('c.ok wraps its input with ANSI escape codes (green) when colors are on', () => {
    const out = c.ok('hello');
    expect(typeof out).toBe('string');
    // FORCE_COLOR=1 should add ANSI sequences; total length grows beyond plain text.
    expect(out.length).toBeGreaterThan('hello'.length);
    expect(out).toContain('hello');
    // Green (32) is the canonical picocolors green code.
    expect(out).toContain('[32m');
  });

  it('c.warn wraps its input with the yellow ANSI sequence', () => {
    const out = c.warn('warning');
    expect(out).toContain('warning');
    expect(out).toContain('[33m');
  });

  it('c.err wraps its input with the red ANSI sequence', () => {
    const out = c.err('boom');
    expect(out).toContain('boom');
    expect(out).toContain('[31m');
  });

  it('c.dim and c.bold both return strings that include the original text', () => {
    expect(c.dim('quiet')).toContain('quiet');
    expect(c.bold('strong')).toContain('strong');
  });
});
