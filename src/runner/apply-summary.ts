/**
 * RUN-09 success-summary text. Matches README §4 quick-start step 6
 * byte-for-byte modulo timestamps, durations, and counts.
 *
 * Pitfall 5 (RESEARCH): the format IS the documentation contract; any
 * drift is a test failure. The snapshot test pins the format; if README
 * §4 drifts from this output, fix README OR update both in lockstep
 * (the inline-snapshot diff makes the change reviewable).
 *
 * Color-free output. Plan 12's `apply` CLI command wraps the headline
 * line in `c.ok(...)` when writing to stderr.
 */

export interface MigrationSummaryEntry {
  id: string;
  entityName: string;
  fromVersion: string;
  toVersion: string;
  itemCounts: { scanned: number; migrated: number; deleted?: number; skipped: number; failed: number };
}

export interface ApplySummaryArgs {
  migrations: ReadonlyArray<MigrationSummaryEntry>;
  totalElapsedMs: number;
}

/**
 * Render the apply success summary shown to the operator after a successful
 * `electrodb-migrations apply` run.
 *
 * Output is plain text — no picocolors. The calling CLI command (`apply.ts`)
 * applies color to the headline line if it wants it.
 */
export function renderApplySummary(args: ApplySummaryArgs): string {
  const lines: string[] = [];
  const elapsed = formatElapsed(args.totalElapsedMs);
  const count = args.migrations.length;

  lines.push('');
  lines.push(`Applied ${count} migration${count === 1 ? '' : 's'} in ${elapsed}.`);

  for (const m of args.migrations) {
    const c = m.itemCounts;
    lines.push(
      `  • ${m.id} (${m.entityName} v${m.fromVersion}→v${m.toVersion}): ${c.scanned} scanned, ${c.migrated} migrated, ${c.skipped} skipped, ${c.failed} failed`,
    );
  }

  lines.push('');
  lines.push('Next steps:');
  lines.push('  1. Run `electrodb-migrations release` after deploying the new code');
  lines.push('  2. After bake-in, run `electrodb-migrations finalize <id>` to delete v1 records');
  lines.push('');

  return lines.join('\n');
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
