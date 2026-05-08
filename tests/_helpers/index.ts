/**
 * Barrel for cross-cutting test helpers (used by both unit and integration suites).
 * Symbols are named explicitly — never `export *`.
 */

export { installFakeClock, type FakeClockHandle } from './clock.js';
export {
  scanFiles,
  stripCommentLines,
  type ScanOptions,
  type SourceLineMatch,
} from './source-scan.js';
