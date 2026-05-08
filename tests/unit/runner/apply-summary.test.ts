import { describe, expect, it } from 'vitest';
import { renderApplySummary } from '../../../src/runner/apply-summary.js';

describe('renderApplySummary', () => {
  it('AS-1: single migration, all-success — matches snapshot and contains release step', () => {
    const output = renderApplySummary({
      migrations: [
        {
          id: '20260601-User-add-status',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          itemCounts: { scanned: 1000, migrated: 1000, skipped: 0, failed: 0 },
        },
      ],
      totalElapsedMs: 12345,
    });

    expect(output).toMatchInlineSnapshot(`
"
Applied 1 migration in 12.3s.
  • 20260601-User-add-status (User v1→v2): 1000 scanned, 1000 migrated, 0 skipped, 0 failed

Next steps:
  1. Run \`electrodb-migrations release\` after deploying the new code
  2. After bake-in, run \`electrodb-migrations finalize <id>\` to delete v1 records
"
`);

    expect(output).toContain('Run `electrodb-migrations release` after deploying the new code');
  });

  it('AS-2: two migrations in batch — each has its own bullet line with entity/version segment', () => {
    const output = renderApplySummary({
      migrations: [
        {
          id: '20260601-User-add-status',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          itemCounts: { scanned: 500, migrated: 500, skipped: 0, failed: 0 },
        },
        {
          id: '20260602-Order-add-note',
          entityName: 'Order',
          fromVersion: '3',
          toVersion: '4',
          itemCounts: { scanned: 200, migrated: 200, skipped: 0, failed: 0 },
        },
      ],
      totalElapsedMs: 30000,
    });

    expect(output).toMatchInlineSnapshot(`
"
Applied 2 migrations in 30.0s.
  • 20260601-User-add-status (User v1→v2): 500 scanned, 500 migrated, 0 skipped, 0 failed
  • 20260602-Order-add-note (Order v3→v4): 200 scanned, 200 migrated, 0 skipped, 0 failed

Next steps:
  1. Run \`electrodb-migrations release\` after deploying the new code
  2. After bake-in, run \`electrodb-migrations finalize <id>\` to delete v1 records
"
`);

    expect(output).toContain('(User v1→v2)');
    expect(output).toContain('(Order v3→v4)');
  });

  it('AS-3: skip count > 0 surfaces in bullet line', () => {
    const output = renderApplySummary({
      migrations: [
        {
          id: '20260601-User-add-status',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          itemCounts: { scanned: 1, migrated: 0, skipped: 1, failed: 0 },
        },
      ],
      totalElapsedMs: 500,
    });

    expect(output).toContain('1 scanned, 0 migrated, 1 skipped, 0 failed');
  });

  it('AS-4a: elapsed time >= 1000ms formats as seconds with one decimal', () => {
    const output12345 = renderApplySummary({
      migrations: [{ id: 'x', entityName: 'E', fromVersion: '1', toVersion: '2', itemCounts: { scanned: 0, migrated: 0, skipped: 0, failed: 0 } }],
      totalElapsedMs: 12345,
    });
    expect(output12345).toContain('12.3s');

    const output120000 = renderApplySummary({
      migrations: [{ id: 'x', entityName: 'E', fromVersion: '1', toVersion: '2', itemCounts: { scanned: 0, migrated: 0, skipped: 0, failed: 0 } }],
      totalElapsedMs: 120000,
    });
    expect(output120000).toContain('120.0s');
  });

  it('AS-4b: elapsed time < 1000ms formats with ms suffix', () => {
    const output = renderApplySummary({
      migrations: [{ id: 'x', entityName: 'E', fromVersion: '1', toVersion: '2', itemCounts: { scanned: 0, migrated: 0, skipped: 0, failed: 0 } }],
      totalElapsedMs: 999,
    });
    expect(output).toContain('999ms');
  });

  it('AS-5: output contains no picocolors — format is plain text (no ANSI escape codes)', () => {
    const output = renderApplySummary({
      migrations: [
        {
          id: '20260601-User-add-status',
          entityName: 'User',
          fromVersion: '1',
          toVersion: '2',
          itemCounts: { scanned: 1, migrated: 1, skipped: 0, failed: 0 },
        },
      ],
      totalElapsedMs: 100,
    });
    // ANSI escape code pattern: ESC [ ... m
    expect(output).not.toMatch(/\x1b\[/);
  });
});
