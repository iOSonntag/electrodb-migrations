import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../../src/cli/output/log.js';

/**
 * picocolors caches isColorSupported once at module load, so toggling
 * FORCE_COLOR mid-test has no effect on the wrapped output. Assertions here
 * use `toContain(<glyph>)` so they pass under both color-on and color-off
 * environments — what matters is that:
 *   1. every helper writes to stderr only (CLI-08 / CLI-09),
 *   2. log.err with a remediation produces TWO writes (CLI-09).
 */
describe('log.ts (CLI-08, CLI-09 — stderr discipline + remediation suffix)', () => {
  // Use a permissive MockInstance type so we don't have to spell out the
  // overload-rich `process.stderr.write` signature; what we care about in this
  // suite is `mock.calls.length` and `mock.calls[i][0]`.
  let stderrSpy: MockInstance;
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('log.info writes plain text + newline to stderr (no glyph)', () => {
    log.info('hello');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith('hello\n');
  });

  it('log.ok writes a check glyph + message + newline to stderr', () => {
    log.ok('saved');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toContain('✔');
    expect(written).toContain('saved');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('log.warn writes a "!" glyph + message + newline to stderr', () => {
    log.warn('careful');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toContain('!');
    expect(written).toContain('careful');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('log.err with no remediation writes a single line containing the cross glyph + message', () => {
    log.err('boom');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toContain('✘');
    expect(written).toContain('boom');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('log.err with remediation writes TWO lines (CLI-09): err line, then "  → remediation"', () => {
    log.err('config invalid', 'run electrodb-migrations init to scaffold one');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const first = String(stderrSpy.mock.calls[0]?.[0]);
    const second = String(stderrSpy.mock.calls[1]?.[0]);
    expect(first).toContain('✘');
    expect(first).toContain('config invalid');
    expect(second).toContain('→');
    expect(second).toContain('run electrodb-migrations init');
    // The remediation line is indented with two spaces.
    expect(second.startsWith('  ')).toBe(true);
  });

  it('NO log helper ever touches process.stdout', () => {
    log.info('a');
    log.ok('b');
    log.warn('c');
    log.err('d');
    log.err('e', 'remediation');
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
  });
});
