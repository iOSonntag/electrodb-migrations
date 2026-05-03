/**
 * Recursively sorts object keys before serialization. Arrays preserve order
 * (positional). Throws on Date/Map/Set/Function/class-instance — the caller
 * must project to pure-JSON shapes first (Plan 08's projection module
 * guarantees this for entity fingerprints).
 *
 * Determinism is load-bearing: two equivalent projections MUST hash to the
 * same SHA-256 across Node versions and OSes. Pitfall #4.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`canonicalJson: non-plain-object encountered (${Object.prototype.toString.call(value)})`);
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return sorted;
}
