import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { type Colorizer, c } from '../../../../src/cli/output/colors.js';

/**
 * picocolors decides isColorSupported once at module load (reads
 * process.env.FORCE_COLOR / process.stdout.isTTY). We can't reliably toggle
 * colors after import, so the assertions branch on `pc.isColorSupported`:
 * - colors on  -> assert ANSI escape sequences are present
 * - colors off -> assert outputs are pass-through plaintext
 * Both states are valid CLI environments and both must round-trip the input.
 */
describe('colors.ts (CLI-08)', () => {
  it('exports the five Colorizer methods (ok / warn / err / dim / bold)', () => {
    const required: Array<keyof Colorizer> = ['ok', 'warn', 'err', 'dim', 'bold'];
    for (const key of required) {
      expect(typeof c[key]).toBe('function');
    }
  });

  it('c.ok always round-trips the input text and uses picocolors.green', () => {
    const out = c.ok('hello');
    expect(typeof out).toBe('string');
    expect(out).toContain('hello');
    expect(out).toBe(pc.green('hello'));
    if (pc.isColorSupported) {
      // 32 is the canonical SGR code for green.
      expect(out).toContain('[32m');
    } else {
      expect(out).toBe('hello');
    }
  });

  it('c.warn uses picocolors.yellow', () => {
    const out = c.warn('warning');
    expect(out).toContain('warning');
    expect(out).toBe(pc.yellow('warning'));
    if (pc.isColorSupported) {
      expect(out).toContain('[33m');
    }
  });

  it('c.err uses picocolors.red', () => {
    const out = c.err('boom');
    expect(out).toContain('boom');
    expect(out).toBe(pc.red('boom'));
    if (pc.isColorSupported) {
      expect(out).toContain('[31m');
    }
  });

  it('c.dim and c.bold both round-trip the input through picocolors', () => {
    expect(c.dim('quiet')).toBe(pc.dim('quiet'));
    expect(c.bold('strong')).toBe(pc.bold('strong'));
    expect(c.dim('quiet')).toContain('quiet');
    expect(c.bold('strong')).toContain('strong');
  });
});
