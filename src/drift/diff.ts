import type { Drift } from './classify.js';

/**
 * Schema diff renderer (SCF-06). Pure function over `Drift[]` — emits a
 * single human-readable string matching the README §4 canonical format
 * (`User: v1 → v2\n  + status: 'active' | 'inactive' (required) ⚠
 * NEEDS DEFAULT IN up()\n`).
 *
 * Colorization is INJECTED via the `colorize: Colorizer` option. The
 * renderer never imports `picocolors`; the CLI plan (Plan 05 wires the
 * picocolors-backed colorizer at call site). The default identity
 * colorizer keeps the renderer unit-testable as plaintext bytes.
 *
 * Glyph table:
 *  - `+` — additions; wrapped in `colorize.ok`
 *  - `-` — removals; wrapped in `colorize.err`
 *  - `~` — changes / renames; wrapped in `colorize.warn`
 *  - `⨯` — entity-removed; wrapped in `colorize.err`
 *  - `⚠ NEEDS DEFAULT IN up()` — required-without-default; wrapped in `colorize.warn`
 *  - `↳` — sub-line indent for multi-field changes; wrapped in `colorize.dim`
 *
 * Threat note (T-02-02-04): the renderer trusts attribute / index /
 * entity name strings as-is per Phase 1's `projectEntityModel`
 * contract. Output discipline (sanitization of terminal control chars
 * in user-controlled names) is the colorizer adapter's responsibility
 * (Plan 05).
 *
 * @see README §4 Quick start (lines 90-100)
 */

/* ----- Public types --------------------------------------------------- */

export interface Colorizer {
  ok: (s: string) => string;
  warn: (s: string) => string;
  err: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const IDENTITY_COLORIZER: Colorizer = {
  ok: (s) => s,
  warn: (s) => s,
  err: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
};

export interface RenderSchemaDiffOptions {
  entityName: string;
  fromVersion: string;
  toVersion: string;
  colorize?: Colorizer;
}

/* ----- Public API ----------------------------------------------------- */

export function renderSchemaDiff(drifts: ReadonlyArray<Drift>, opts: RenderSchemaDiffOptions): string {
  const c = opts.colorize ?? IDENTITY_COLORIZER;
  const lines: string[] = [];
  lines.push(`${opts.entityName}: v${opts.fromVersion} → v${opts.toVersion}`);

  if (drifts.length === 0) {
    lines.push('  (no shape drift)');
    return `${lines.join('\n')}\n`;
  }

  for (const drift of drifts) {
    switch (drift.kind) {
      case 'attribute-added':
        lines.push(...renderAttributeAdded(drift, c));
        break;
      case 'attribute-removed':
        lines.push(`  ${c.err('-')} ${drift.name}: ${formatType(drift.type)}`);
        break;
      case 'attribute-changed':
        lines.push(...renderAttributeChanged(drift, c));
        break;
      case 'index-added':
        lines.push(renderIndexAdded(drift, c));
        break;
      case 'index-removed':
        lines.push(`  ${c.err('-')} index ${drift.name}`);
        break;
      case 'index-changed':
        lines.push(...renderIndexChanged(drift, c));
        break;
      case 'key-rename':
        lines.push(`  ${c.warn('~')} rename ${drift.index}.${drift.keyType}: ${drift.from} → ${drift.to}`);
        break;
      case 'entity-removed':
        lines.push(`  ${c.err('⨯')} entity-removed: ${drift.entity} (service: ${drift.service})`);
        break;
    }
  }

  return `${lines.join('\n')}\n`;
}

/* ----- Per-kind renderers --------------------------------------------- */

function renderAttributeAdded(drift: Extract<Drift, { kind: 'attribute-added' }>, c: Colorizer): string[] {
  const typeStr = formatType(drift.type);
  const requiredSuffix = drift.required ? '(required)' : '(optional)';
  const base = `  ${c.ok('+')} ${drift.name}: ${typeStr} ${requiredSuffix}`;
  if (drift.warnNeedsDefault) {
    return [`${base} ${c.warn('⚠ NEEDS DEFAULT IN up()')}`];
  }
  return [base];
}

function renderAttributeChanged(drift: Extract<Drift, { kind: 'attribute-changed' }>, c: Colorizer): string[] {
  if (drift.changes.length === 1) {
    const ch = drift.changes[0];
    if (ch !== undefined) {
      return [`  ${c.warn('~')} ${drift.name}: ${formatChangeValue(ch.from)} → ${formatChangeValue(ch.to)}`];
    }
  }
  const out: string[] = [`  ${c.warn('~')} ${drift.name}`];
  for (const change of drift.changes) {
    out.push(`    ${c.dim('↳')} ${change.field}: ${formatChangeValue(change.from)} → ${formatChangeValue(change.to)}`);
  }
  return out;
}

function renderIndexAdded(drift: Extract<Drift, { kind: 'index-added' }>, c: Colorizer): string {
  const pkStr = `pk=${formatComposite(drift.pkComposite)}`;
  if (drift.skComposite !== undefined) {
    return `  ${c.ok('+')} index ${drift.name}: ${pkStr}, sk=${formatComposite(drift.skComposite)}`;
  }
  return `  ${c.ok('+')} index ${drift.name}: ${pkStr}`;
}

function renderIndexChanged(drift: Extract<Drift, { kind: 'index-changed' }>, c: Colorizer): string[] {
  if (drift.changes.length === 1) {
    const ch = drift.changes[0];
    if (ch !== undefined) {
      return [`  ${c.warn('~')} index ${drift.name}.${ch.field}: ${formatChangeValue(ch.from)} → ${formatChangeValue(ch.to)}`];
    }
  }
  const out: string[] = [`  ${c.warn('~')} index ${drift.name}`];
  for (const change of drift.changes) {
    out.push(`    ${c.dim('↳')} ${change.field}: ${formatChangeValue(change.from)} → ${formatChangeValue(change.to)}`);
  }
  return out;
}

/* ----- Value formatters ----------------------------------------------- */

/**
 * Format a `ProjectedAttribute['type']` for display:
 *  - readonly array (enum) → `'a' | 'b' | 'c'`
 *  - plain string → bare identifier (`string`, `number`, ...)
 */
function formatType(t: string | readonly string[]): string {
  if (Array.isArray(t)) {
    return t.map((v) => `'${v}'`).join(' | ');
  }
  return String(t);
}

/**
 * Format a composite array as `[a, b, c]` (square brackets, comma+space
 * separator, no quotes on the inner identifiers — matches README §4
 * "pk=[id], sk=[createdAt]" format).
 */
function formatComposite(c: readonly string[]): string {
  return `[${c.join(', ')}]`;
}

/**
 * Format a change-value (from / to) for display:
 *  - undefined → `<unset>`
 *  - string → `'<value>'` (quoted to surface whitespace / case)
 *  - readonly array → `[a, b, c]`
 *  - boolean / number / null → bare literal
 *  - object → `JSON.stringify` (last-resort fallback)
 */
function formatChangeValue(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (typeof v === 'string') return `'${v}'`;
  if (Array.isArray(v)) return formatComposite(v as readonly string[]);
  if (typeof v === 'boolean' || typeof v === 'number' || v === null) {
    return String(v);
  }
  return JSON.stringify(v);
}
