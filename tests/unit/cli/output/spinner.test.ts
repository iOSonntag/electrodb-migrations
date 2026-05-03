import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Spinner, createSpinner } from '../../../../src/cli/output/spinner.js';

describe('spinner.ts (CLI-08 — wrapper around yocto-spinner)', () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    // Silence yocto-spinner's animation writes during tests so they don't
    // leak into the vitest report. Spinner output goes to stderr by default.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('createSpinner returns an object with the documented method surface', () => {
    const sp: Spinner = createSpinner('Loading...');
    expect(typeof sp.start).toBe('function');
    expect(typeof sp.setText).toBe('function');
    expect(typeof sp.success).toBe('function');
    expect(typeof sp.error).toBe('function');
    expect(typeof sp.stop).toBe('function');
  });

  it('start() does not throw in a non-TTY test environment', () => {
    const sp = createSpinner('starting');
    expect(() => {
      sp.start();
      sp.stop();
    }).not.toThrow();
  });

  it('setText/success/error are no-throw even when called before start', () => {
    const sp = createSpinner('initial');
    expect(() => {
      sp.setText('updated');
      sp.success('done');
    }).not.toThrow();

    const sp2 = createSpinner('initial');
    expect(() => {
      sp2.setText('updated');
      sp2.error('failed');
    }).not.toThrow();
  });
});
