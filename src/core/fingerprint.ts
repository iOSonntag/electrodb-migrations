import { createHash } from 'node:crypto';

// Recursively sorts object keys and strips undefined values.
// Arrays are preserved in order — array ordering is semantically significant in schemas.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
};

// Produces a deterministic JSON string regardless of key insertion order.
// Safe to use as a stable basis for hashing: robust to formatting changes,
// sensitive only to resolved schema content.
export const toCanonicalJSON = (value: unknown): string => JSON.stringify(canonicalize(value));

// sha256 of the canonical JSON representation, hex-encoded.
// Identical schemas always produce the same fingerprint; any schema change
// (added field, renamed key, changed type) produces a different one.
export const fingerprint = (schema: unknown): string =>
  createHash('sha256').update(toCanonicalJSON(schema)).digest('hex');
