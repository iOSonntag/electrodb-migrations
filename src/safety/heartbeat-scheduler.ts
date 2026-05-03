/**
 * Pitfall #3 — `setInterval` queues callbacks during Lambda freeze; on thaw
 * they all fire at once, writing stale heartbeats for a runner that may no
 * longer be alive. `setInterval` also starves when the event loop is busy.
 *
 * A self-rescheduling `setTimeout` chain fires correctly and handles async
 * backpressure: each tick awaits `work()` before scheduling the next.
 *
 * IMPORTANT: this module MUST NEVER import or reference `setInterval`. A unit
 * test source-scans this file's contents to verify (see
 * `tests/unit/safety/heartbeat-scheduler.test.ts`).
 */
export interface HeartbeatScheduler {
  stop: () => Promise<void>;
}

export interface HeartbeatOptions {
  /** Period between heartbeat ticks. Phase 3 wires `config.lock.heartbeatMs`. */
  intervalMs: number;
  /** The work to perform on each tick. Awaited; rejection counts toward abort. */
  work: () => Promise<void>;
  /**
   * Max consecutive `work()` failures before scheduler aborts (calls `onAbort`
   * and stops). Default 2 (LCK-10 + Assumption A4 — research-supported but not
   * field-validated; configurable knob hidden until v0.2 dogfooding).
   */
  maxConsecutiveFailures?: number;
  /** Called once when the scheduler aborts due to repeated failures. */
  onAbort?: (err: unknown) => void;
}

export function startHeartbeatScheduler(opts: HeartbeatOptions): HeartbeatScheduler {
  const maxFailures = opts.maxConsecutiveFailures ?? 2;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let runningWork: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    runningWork = opts.work();
    try {
      await runningWork;
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        stopped = true;
        opts.onAbort?.(err);
        return;
      }
    } finally {
      runningWork = null;
    }
    if (!stopped) {
      timer = setTimeout(tick, opts.intervalMs);
    }
  };

  // First tick fires after intervalMs (not immediately) — gives the lock
  // acquire path time to settle before the first heartbeat write.
  timer = setTimeout(tick, opts.intervalMs);

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (runningWork) await runningWork.catch(() => undefined);
    },
  };
}
