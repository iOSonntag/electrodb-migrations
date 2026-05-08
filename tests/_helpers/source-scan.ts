/**
 * Single source-scan utility used by the LCK-07 / GRD-02 invariant tests in
 * Plan 04 and the Plan 08 follow-on invariants.
 *
 * Adapts the comment-stripping convention from `tests/unit/safety/heartbeat-scheduler.test.ts:99-116`
 * so JSDoc that *names* a forbidden API (e.g. `setInterval`) does not trip the
 * scan. The comment-strip path is opt-in via `options.stripComments`.
 */

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

export interface SourceLineMatch {
  file: string;
  line: number;
  snippet: string;
}

export interface ScanOptions {
  /** When true, strip lines starting with `//`, `/*`, `*` before applying the predicate. */
  stripComments?: boolean;
}

export const scanFiles = async (globPattern: string, predicate: (line: string, lineNumber: number, file: string) => boolean, options: ScanOptions = {}): Promise<SourceLineMatch[]> => {
  const matches: SourceLineMatch[] = [];
  for await (const file of glob(globPattern)) {
    const raw = readFileSync(file, 'utf8');
    const lines = options.stripComments ? stripCommentLines(raw).split('\n') : raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (predicate(line, i + 1, file)) {
        matches.push({ file, line: i + 1, snippet: line.trim() });
      }
    }
  }
  return matches;
};

/**
 * Drop comment-only lines (those whose trimmed prefix is `//`, `/*`, or `*`).
 * Inline comments later on a code line are preserved — the load-bearing rule
 * is "JSDoc that names the forbidden API doesn't trip the scan", not a full
 * comment-stripper.
 */
export const stripCommentLines = (src: string): string => {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith('//')) return false;
      if (t.startsWith('/*')) return false;
      if (t.startsWith('*')) return false;
      return true;
    })
    .join('\n');
};
