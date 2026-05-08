/**
 * Synchronous best-effort probe of port 8000 with a configurable timeout.
 *
 * Integration tests' `beforeAll` calls this so that, when DDB Local is not
 * running, every test in the file can no-op cleanly (a `console.warn` plus
 * an early return) instead of failing the suite with a confusing AWS SDK
 * "ECONNREFUSED" stack. The integration suite is environment-sensitive by
 * design — see RESEARCH §"Environment Availability".
 */

import { Socket } from 'node:net';

export const isDdbLocalReachable = async (timeoutMs = 1000): Promise<boolean> => {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(8000, 'localhost');
  });
};

export const skipMessage = (): string => {
  return 'DDB Local not reachable on localhost:8000 — run `docker compose up -d dynamodb-local` to enable integration tests.';
};
