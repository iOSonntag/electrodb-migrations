import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startHeartbeatScheduler } from '../../../src/safety/heartbeat-scheduler.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startHeartbeatScheduler', () => {
  it('does NOT fire work() before the first intervalMs elapses', async () => {
    const work = vi.fn(async () => {});
    const sched = startHeartbeatScheduler({ intervalMs: 100, work });
    expect(work).not.toHaveBeenCalled();
    await sleep(20);
    expect(work).not.toHaveBeenCalled();
    await sched.stop();
  });

  it('fires work() repeatedly at intervalMs cadence', async () => {
    const work = vi.fn(async () => {});
    const sched = startHeartbeatScheduler({ intervalMs: 50, work });
    await sleep(180);
    await sched.stop();
    // ~3 ticks (50, 100, 150ms), tolerate ±1 due to timer jitter
    expect(work.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(work.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('serializes work() invocations: no overlap when work takes longer than intervalMs', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const work = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(60);
      inFlight -= 1;
    });
    const sched = startHeartbeatScheduler({ intervalMs: 20, work });
    await sleep(200);
    await sched.stop();
    expect(maxConcurrent).toBe(1);
  });

  it('aborts after 2 consecutive failures by default and calls onAbort once', async () => {
    const onAbort = vi.fn();
    const work = vi.fn(async () => {
      throw new Error('boom');
    });
    const sched = startHeartbeatScheduler({ intervalMs: 30, work, onAbort });
    await sleep(150);
    await sched.stop();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(work.mock.calls.length).toBe(2);
  });

  it('resets consecutive-failure count on success (does not abort on alternating fail/succeed)', async () => {
    let n = 0;
    const onAbort = vi.fn();
    const work = vi.fn(async () => {
      n += 1;
      if (n % 2 === 1) throw new Error('odd');
    });
    const sched = startHeartbeatScheduler({ intervalMs: 30, work, onAbort });
    await sleep(200);
    await sched.stop();
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('stop is idempotent and resolves cleanly', async () => {
    const work = vi.fn(async () => {});
    const sched = startHeartbeatScheduler({ intervalMs: 50, work });
    await sleep(70);
    await sched.stop();
    await expect(sched.stop()).resolves.toBeUndefined();
  });

  it('stop awaits in-flight work', async () => {
    let resolveWork: (() => void) | null = null;
    const work = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveWork = r;
        }),
    );
    const sched = startHeartbeatScheduler({ intervalMs: 30, work });
    await sleep(50);
    expect(work).toHaveBeenCalled();
    const stopPromise = sched.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    await sleep(20);
    expect(stopResolved).toBe(false);
    resolveWork!();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('source contains no setInterval reference (Pitfall #3 invariant)', () => {
    const path = resolve(__dirname, '../../../src/safety/heartbeat-scheduler.ts');
    const src = readFileSync(path, 'utf8');
    // Strip lines that are JSDoc/inline comments (start with `//`, `/*`, `*`, or ` *`).
    // The JSDoc itself discusses the setInterval anti-pattern, so we must not
    // accidentally fail on documentation that names the forbidden API.
    const stripped = src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (t.startsWith('//')) return false;
        if (t.startsWith('/*')) return false;
        if (t.startsWith('*')) return false;
        return true;
      })
      .join('\n');
    expect(stripped).not.toMatch(/setInterval/);
  });
});
