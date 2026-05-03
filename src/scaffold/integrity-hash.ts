/**
 * SHA-256 integrity hash for frozen-snapshot file bytes. SCF-02.
 *
 * Mirrors Phase 1's `fingerprintEntityModel` SHA-256 hex pattern but
 * adds a `'sha256:'` prefix so the algorithm is self-describing on the
 * stored migration record. Phase 7's `validate` will fail the integrity
 * check if any file's recorded hash diverges from a fresh recomputation.
 *
 * The prefix is informational (the algorithm is fixed at scaffold time;
 * v0.1 only emits SHA-256). It exists so a future v0.2 could introduce
 * a stronger digest without ambiguity in older snapshot records.
 */
import { createHash } from 'node:crypto';

/**
 * Compute the SHA-256 digest of the input bytes and return it formatted
 * as `sha256:<hex>`.
 *
 * @param bytes - UTF-8 string OR raw Buffer. The two forms produce the
 *                same digest when the string is the UTF-8 decoding of
 *                the buffer (verified by unit test).
 * @returns The string `sha256:<64 lowercase hex chars>`.
 */
export function computeIntegrityHash(bytes: string | Buffer): string {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hex}`;
}
