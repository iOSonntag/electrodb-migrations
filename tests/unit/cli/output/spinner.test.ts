import { describe, expect, it } from 'vitest';
import { createSpinner, type Spinner } from '../../../../src/cli/output/spinner.js';

describe('spinner.ts (CLI-08 — wrapper around yocto-spinner)', () => {
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
