import { describe, expect, it } from 'vitest';
import { formatHistoryJson, type RawHistoryRow } from '../../../src/runner/history-format.js';

const baseRow: RawHistoryRow = {
  id: '20260501-User-add-status',
  schemaVersion: 1,
  kind: 'transform',
  status: 'applied',
  fromVersion: '1',
  toVersion: '2',
  entityName: 'User',
  fingerprint: 'abc123',
};

describe('formatHistoryJson', () => {
  it('HF-1: empty input returns top-level array with trailing newline', () => {
    expect(formatHistoryJson([])).toBe('[]\n');
  });

  it('HF-2: single row returns pretty-printed JSON with 2-space indent', () => {
    const row: RawHistoryRow = {
      id: '20260501083042-User-add-status',
      schemaVersion: 1,
      kind: 'transform',
      status: 'applied',
      appliedAt: '2026-05-01T08:30:42Z',
      fromVersion: '1',
      toVersion: '2',
      entityName: 'User',
      fingerprint: 'abc123',
      itemCounts: { scanned: 100, migrated: 100, skipped: 0, failed: 0 },
    };
    const result = formatHistoryJson([row]);
    expect(result).toMatchInlineSnapshot(`
"[
  {
    "id": "20260501083042-User-add-status",
    "schemaVersion": 1,
    "kind": "transform",
    "status": "applied",
    "appliedAt": "2026-05-01T08:30:42Z",
    "fromVersion": "1",
    "toVersion": "2",
    "entityName": "User",
    "fingerprint": "abc123",
    "itemCounts": {
      "scanned": 100,
      "migrated": 100,
      "skipped": 0,
      "failed": 0
    }
  }
]
"
`);
  });

  it('HF-3: Set<string> reads are converted to sorted string array', () => {
    const row: RawHistoryRow = {
      ...baseRow,
      reads: new Set(['Team', 'Org', 'App']),
    };
    const result = formatHistoryJson([row]);
    const parsed = JSON.parse(result);
    expect(parsed[0].reads).toEqual(['App', 'Org', 'Team']);
  });

  it('HF-4: date fields are kept as ISO-8601 strings verbatim (no epoch conversion)', () => {
    const row: RawHistoryRow = {
      ...baseRow,
      appliedAt: '2026-05-01T08:30:42Z',
    };
    const result = formatHistoryJson([row]);
    expect(result).toContain('"appliedAt": "2026-05-01T08:30:42Z"');
  });

  it('HF-5: rows are sorted by id ascending regardless of input order', () => {
    const rows: RawHistoryRow[] = [
      { ...baseRow, id: 'c-migration', entityName: 'C' },
      { ...baseRow, id: 'a-migration', entityName: 'A' },
      { ...baseRow, id: 'b-migration', entityName: 'B' },
    ];
    const result = formatHistoryJson(rows);
    const parsed = JSON.parse(result);
    expect(parsed.map((r: { id: string }) => r.id)).toEqual(['a-migration', 'b-migration', 'c-migration']);
  });

  it('HF-6: entity filter option limits output to matching entityName rows', () => {
    const rows: RawHistoryRow[] = [
      { ...baseRow, id: 'a', entityName: 'User' },
      { ...baseRow, id: 'b', entityName: 'Order' },
      { ...baseRow, id: 'c', entityName: 'User' },
    ];
    const result = formatHistoryJson(rows, { entity: 'User' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r: { entityName: string }) => r.entityName === 'User')).toBe(true);
  });
});
