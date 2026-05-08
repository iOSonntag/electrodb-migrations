import { describe, expect, it } from 'vitest';
import { sleep } from '../../../src/runner/sleep.js';

describe('sleep', () => {
  it('SLP-1: sleep(0) resolves', async () => {
    // sleep(0) resolves on the next macrotask; just assert it returns a Promise<void>
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('SLP-2: sleep(50) waits at least ~45ms', async () => {
    const t0 = Date.now();
    await sleep(50);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });
});
