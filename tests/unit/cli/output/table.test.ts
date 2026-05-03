import { describe, expect, it } from 'vitest';
import { createTable } from '../../../../src/cli/output/table.js';

describe('table.ts (CLI-08 — wrapper around cli-table3)', () => {
  it('renders a non-empty string for a head + rows pair', () => {
    const out = createTable({ head: ['a', 'b'], rows: [['1', '2']] }).toString();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('rendered output contains every header label and every row value', () => {
    const out = createTable({
      head: ['Entity', 'Version'],
      rows: [
        ['User', '1'],
        ['Order', '2'],
      ],
    }).toString();
    for (const needle of ['Entity', 'Version', 'User', 'Order', '1', '2']) {
      expect(out).toContain(needle);
    }
  });

  it('renders without rows (head-only)', () => {
    const out = createTable({ head: ['only-header'] }).toString();
    expect(out).toContain('only-header');
  });

  it('does not embed cli-table3 default head colors (style.head set to [] in the wrapper)', () => {
    // cli-table3 default head color is red; with style.head=[], no leading
    // red ANSI sequence should appear before the first head label.
    const out = createTable({ head: ['Plain'] }).toString();
    // Find the index of "Plain"; everything before it must not contain an ESC code.
    const idx = out.indexOf('Plain');
    expect(idx).toBeGreaterThan(-1);
    const prefix = out.slice(0, idx);
    expect(prefix).not.toMatch(/\[\d+m/);
  });
});
