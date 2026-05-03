import { c } from './colors.js';

/**
 * stderr-discipline logger.
 *
 * - Every helper writes to `process.stderr` only — STDOUT is reserved
 *   for machine-readable output (`baseline` summary table, future `--json`
 *   modes from `history` / `status`).
 * - CLI-09: `err(line, remediation?)` writes the error glyph + message, then
 *   on a second indented line the dim-arrow remediation. Every fatal CLI
 *   error site MUST pass a remediation; the optional second argument is for
 *   stack-internal callers that already shape their own remediation upstream.
 * - All colors flow through `colors.ts`, the only file allowed to import
 *   `picocolors`.
 */
export const log = {
  info: (line: string): void => {
    process.stderr.write(`${line}\n`);
  },
  ok: (line: string): void => {
    process.stderr.write(`${c.ok('✔')} ${line}\n`);
  },
  warn: (line: string): void => {
    process.stderr.write(`${c.warn('!')} ${line}\n`);
  },
  err: (line: string, remediation?: string): void => {
    process.stderr.write(`${c.err('✘')} ${line}\n`);
    if (remediation !== undefined) {
      process.stderr.write(`  ${c.dim('→')} ${remediation}\n`);
    }
  },
};
