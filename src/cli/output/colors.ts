import pc from 'picocolors';

/**
 * Colorizer adapter shape — matches `src/drift/diff.ts`'s `Colorizer` so the
 * schema-diff renderer can be passed `c` directly. CLI-08.
 *
 * Picocolors is the only place picocolors is imported in the framework's
 * source tree. Plans 02 / 06 / 07 / 08 / 09 consume colors via this `c`
 * value (or an injected `Colorizer`); they never import picocolors directly.
 */
export interface Colorizer {
  ok: (s: string) => string;
  warn: (s: string) => string;
  err: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

export const c: Colorizer = {
  ok: pc.green,
  warn: pc.yellow,
  err: pc.red,
  dim: pc.dim,
  bold: pc.bold,
};
