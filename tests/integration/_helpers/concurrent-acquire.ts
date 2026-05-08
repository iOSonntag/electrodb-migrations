/**
 * Race N parallel async functions; classify the settled outcomes into winners and losers.
 *
 * Used by Plan 06's LCK-01 race verification — N concurrent `acquireLock()` calls
 * against the same lock row, where the conditional write guarantees exactly one
 * winner. The harness deliberately uses `Promise.allSettled` (not `Promise.all`)
 * so a single rejection does not unwind the rest of the race; we want to inspect
 * every outcome.
 */

export interface RaceResult<T> {
  winners: T[];
  losers: { reason: unknown }[];
}

export const raceAcquires = async <T>(attempts: Array<() => Promise<T>>): Promise<RaceResult<T>> => {
  const settled = await Promise.allSettled(attempts.map((fn) => fn()));
  const winners: T[] = [];
  const losers: { reason: unknown }[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      winners.push(result.value);
    } else {
      losers.push({ reason: result.reason });
    }
  }
  return { winners, losers };
};
