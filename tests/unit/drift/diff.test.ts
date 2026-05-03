import { describe, expect, it } from 'vitest';
import type { Drift } from '../../../src/drift/classify.js';
import { type Colorizer, renderSchemaDiff } from '../../../src/drift/diff.js';

const OPTS = { entityName: 'User', fromVersion: '1', toVersion: '2' };

describe('renderSchemaDiff — empty drifts', () => {
  it('returns header + (no shape drift) when drifts is empty', () => {
    expect(renderSchemaDiff([], OPTS)).toBe('User: v1 → v2\n  (no shape drift)\n');
  });
});

describe('renderSchemaDiff — header', () => {
  it('first line is "<entity>: v<from> → v<to>" with U+2192 arrow', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'status',
        type: 'string',
        required: false,
        warnNeedsDefault: false,
      },
    ];
    const out = renderSchemaDiff(drifts, OPTS);
    const firstLine = out.split('\n')[0];
    expect(firstLine).toBe('User: v1 → v2');
    expect(firstLine).toContain('→');
  });
});

describe('renderSchemaDiff — attribute-added', () => {
  it('required + needs-default emits ⚠ NEEDS DEFAULT IN up()', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'status',
        type: ['active', 'inactive'],
        required: true,
        warnNeedsDefault: true,
      },
    ];
    const out = renderSchemaDiff(drifts, OPTS);
    expect(out).toBe(
      `User: v1 → v2\n  + status: 'active' | 'inactive' (required) ⚠ NEEDS DEFAULT IN up()\n`,
    );
  });

  it('non-required suppresses warning', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'nickname',
        type: 'string',
        required: false,
        warnNeedsDefault: false,
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      'User: v1 → v2\n  + nickname: string (optional)\n',
    );
  });
});

describe('renderSchemaDiff — attribute-removed', () => {
  it('emits "- <name>: <type>"', () => {
    const drifts: Drift[] = [
      { kind: 'attribute-removed', name: 'status', type: 'string' },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe('User: v1 → v2\n  - status: string\n');
  });
});

describe('renderSchemaDiff — attribute-changed', () => {
  it('single change rendered inline', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-changed',
        name: 'status',
        changes: [{ field: 'type', from: 'string', to: 'number' }],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      `User: v1 → v2\n  ~ status: 'string' → 'number'\n`,
    );
  });

  it('multiple changes render header line + indented sub-lines', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-changed',
        name: 'status',
        changes: [
          { field: 'required', from: false, to: true },
          { field: 'type', from: 'string', to: 'number' },
        ],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      `User: v1 → v2\n  ~ status\n    ↳ required: false → true\n    ↳ type: 'string' → 'number'\n`,
    );
  });
});

describe('renderSchemaDiff — index-added', () => {
  it('with sk: pk + sk composite arrays', () => {
    const drifts: Drift[] = [
      {
        kind: 'index-added',
        name: 'secondary',
        pkComposite: ['email'],
        skComposite: ['createdAt'],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      'User: v1 → v2\n  + index secondary: pk=[email], sk=[createdAt]\n',
    );
  });

  it('without sk: only pk composite array', () => {
    const drifts: Drift[] = [
      { kind: 'index-added', name: 'bare', pkComposite: ['x'] },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe('User: v1 → v2\n  + index bare: pk=[x]\n');
  });
});

describe('renderSchemaDiff — index-removed', () => {
  it('emits "- index <name>"', () => {
    const drifts: Drift[] = [{ kind: 'index-removed', name: 'secondary' }];
    expect(renderSchemaDiff(drifts, OPTS)).toBe('User: v1 → v2\n  - index secondary\n');
  });
});

describe('renderSchemaDiff — index-changed', () => {
  it('single change inline with dotted-field notation', () => {
    const drifts: Drift[] = [
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [{ field: 'pk.composite', from: ['id'], to: ['userId'] }],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      'User: v1 → v2\n  ~ index primary.pk.composite: [id] → [userId]\n',
    );
  });

  it('multiple changes render header + indented sub-lines', () => {
    const drifts: Drift[] = [
      {
        kind: 'index-changed',
        name: 'primary',
        changes: [
          { field: 'pk.casing', from: 'default', to: 'lower' },
          { field: 'pk.composite', from: ['id'], to: ['id', 'tenant'] },
        ],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      `User: v1 → v2\n  ~ index primary\n    ↳ pk.casing: 'default' → 'lower'\n    ↳ pk.composite: [id] → [id, tenant]\n`,
    );
  });
});

describe('renderSchemaDiff — key-rename', () => {
  it('emits "~ rename <index>.<keyType>: <from> → <to>"', () => {
    const drifts: Drift[] = [
      { kind: 'key-rename', index: 'primary', keyType: 'pk', from: 'userId', to: 'accountId' },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      'User: v1 → v2\n  ~ rename primary.pk: userId → accountId\n',
    );
  });
});

describe('renderSchemaDiff — entity-removed', () => {
  it('emits "⨯ entity-removed: <Entity> (service: <service>)"', () => {
    const drifts: Drift[] = [{ kind: 'entity-removed', entity: 'User', service: 'app' }];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      'User: v1 → v2\n  ⨯ entity-removed: User (service: app)\n',
    );
  });
});

describe('renderSchemaDiff — multi-kind composite', () => {
  it('renders one add + one remove + one change in classifier order', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'status',
        type: 'string',
        required: false,
        warnNeedsDefault: false,
      },
      { kind: 'attribute-removed', name: 'oldField', type: 'number' },
      {
        kind: 'attribute-changed',
        name: 'email',
        changes: [{ field: 'field', from: 'email', to: 'emailAddr' }],
      },
    ];
    expect(renderSchemaDiff(drifts, OPTS)).toBe(
      `User: v1 → v2\n  + status: string (optional)\n  - oldField: number\n  ~ email: 'email' → 'emailAddr'\n`,
    );
  });
});

describe('renderSchemaDiff — colorizer adapter', () => {
  it('default identity colorizer produces plaintext output', () => {
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'status',
        type: 'string',
        required: true,
        warnNeedsDefault: true,
      },
    ];
    const out = renderSchemaDiff(drifts, OPTS);
    // No ANSI escape sequences when colorize is omitted
    // biome-ignore lint/suspicious/noControlCharactersInRegex: testing for ANSI escape absence
    expect(/\[/.test(out)).toBe(false);
  });

  it('custom colorizer wraps glyphs with markers', () => {
    const colorize: Colorizer = {
      ok: (s) => `[OK]${s}[/OK]`,
      warn: (s) => `[W]${s}[/W]`,
      err: (s) => `[E]${s}[/E]`,
      dim: (s) => `[D]${s}[/D]`,
      bold: (s) => `[B]${s}[/B]`,
    };
    const drifts: Drift[] = [
      {
        kind: 'attribute-added',
        name: 'status',
        type: 'string',
        required: true,
        warnNeedsDefault: true,
      },
    ];
    const out = renderSchemaDiff(drifts, { ...OPTS, colorize });
    // Plus glyph wrapped with ok marker
    expect(out).toContain('[OK]+[/OK]');
    // Warning glyph + suffix wrapped with warn marker
    expect(out).toContain('[W]⚠ NEEDS DEFAULT IN up()[/W]');
  });

  it('custom colorizer wraps minus glyph for attribute-removed', () => {
    const colorize: Colorizer = {
      ok: (s) => `[OK]${s}[/OK]`,
      warn: (s) => `[W]${s}[/W]`,
      err: (s) => `[E]${s}[/E]`,
      dim: (s) => `[D]${s}[/D]`,
      bold: (s) => `[B]${s}[/B]`,
    };
    const drifts: Drift[] = [
      { kind: 'attribute-removed', name: 'oldField', type: 'number' },
    ];
    const out = renderSchemaDiff(drifts, { ...OPTS, colorize });
    expect(out).toContain('[E]-[/E]');
  });

  it('custom colorizer wraps tilde for attribute-changed and dim for sub-lines', () => {
    const colorize: Colorizer = {
      ok: (s) => `[OK]${s}[/OK]`,
      warn: (s) => `[W]${s}[/W]`,
      err: (s) => `[E]${s}[/E]`,
      dim: (s) => `[D]${s}[/D]`,
      bold: (s) => `[B]${s}[/B]`,
    };
    const drifts: Drift[] = [
      {
        kind: 'attribute-changed',
        name: 'status',
        changes: [
          { field: 'required', from: false, to: true },
          { field: 'type', from: 'string', to: 'number' },
        ],
      },
    ];
    const out = renderSchemaDiff(drifts, { ...OPTS, colorize });
    expect(out).toContain('[W]~[/W]');
    expect(out).toContain('[D]↳[/D]');
  });
});

describe('renderSchemaDiff — trailing newline', () => {
  it('every output ends with \\n', () => {
    const cases: Drift[][] = [
      [],
      [
        {
          kind: 'attribute-added',
          name: 'x',
          type: 'string',
          required: false,
          warnNeedsDefault: false,
        },
      ],
      [{ kind: 'entity-removed', entity: 'User', service: 'app' }],
    ];
    for (const drifts of cases) {
      const out = renderSchemaDiff(drifts, OPTS);
      expect(out.endsWith('\n')).toBe(true);
    }
  });
});
