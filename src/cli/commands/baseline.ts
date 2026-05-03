import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Command } from 'commander';
import { fingerprintEntityModel } from '../../safety/fingerprint-projection.js';
import { entitySnapshotPath, snapshotPaths } from '../../snapshot/paths.js';
import { readEntitySnapshot } from '../../snapshot/read.js';
import type { EntitySnapshotFile, JournalFile } from '../../snapshot/types.js';
import { writeEntitySnapshot, writeJournal } from '../../snapshot/write.js';
import { type EntityMetadata, discoverEntityFiles, extractEntityMetadata, loadEntityFile } from '../../user-entities/index.js';
import { c } from '../output/colors.js';
import { EXIT_CODES } from '../output/exit-codes.js';
import { log } from '../output/log.js';
import { createSpinner } from '../output/spinner.js';
import { createTable } from '../output/table.js';
import { resolveCliConfig } from '../shared/resolve-config.js';

export interface RunBaselineArgs {
  cwd: string;
  /** Path passed via the global `--config <path>` flag, when provided. */
  configFlag?: string;
}

type SnapshotStatus = 'new' | 'unchanged' | 'updated';

/**
 * Snapshot every entity discovered under `config.entities`. Idempotent:
 * re-running with no entity edits leaves every snapshot file byte-identical
 * (the writer is gated on `status !== 'unchanged'` — verified in the unit
 * test via `readFileSync(path, 'utf8')` content comparison, not mtime).
 *
 * INI-03: also UPDATES `_journal.json` to include every discovered entity,
 * giving downstream commands (`create`, `validate`) an authoritative index.
 *
 * Note on idempotency: the journal file is rewritten on every run, even
 * when no per-entity snapshot changed. The writer's `stringifyForSnapshot`
 * pipeline is deterministic (sorted keys + canonical JSON), so the
 * post-write file content is byte-identical when the input is unchanged —
 * the test's byte-equal assertion covers the journal too.
 */
export async function runBaseline(args: RunBaselineArgs): Promise<void> {
  const { config, cwd } = await resolveCliConfig({
    cwd: args.cwd,
    ...(args.configFlag !== undefined ? { configFlag: args.configFlag } : {}),
  });

  const spinner = createSpinner('Discovering entities...');
  spinner.start();
  const files = await discoverEntityFiles({ cwd, entitiesConfig: config.entities });
  if (files.length === 0) {
    spinner.stop();
    log.info(`No entities found at ${JSON.stringify(config.entities)}. Define entities and re-run.`);
    return;
  }

  const allEntities: EntityMetadata[] = [];
  for (const f of files) {
    spinner.setText(`Loading ${relative(cwd, f)}...`);
    const mod = await loadEntityFile(f);
    const metas = extractEntityMetadata(mod, f);
    allEntities.push(...metas);
  }

  const paths = snapshotPaths(cwd);
  const summaryRows: string[][] = [];

  for (const meta of allEntities) {
    spinner.setText(`Fingerprinting ${meta.entityName}...`);
    const { projection, fingerprint } = fingerprintEntityModel((meta.entityInstance as { model: unknown }).model);
    const snapPath = entitySnapshotPath(cwd, meta.entityName);
    const fingerprintWithPrefix = `sha256:${fingerprint}`;

    // `readEntitySnapshot` THROWS on missing file (it propagates the inner
    // ENOENT as EDBSnapshotMalformedError). For the baseline idempotency
    // path we want a tri-state result — existsSync guards the read.
    let status: SnapshotStatus;
    let existing: EntitySnapshotFile | null = null;
    if (existsSync(snapPath)) {
      existing = readEntitySnapshot(snapPath);
      status = existing.fingerprint === fingerprintWithPrefix ? 'unchanged' : 'updated';
    } else {
      status = 'new';
    }

    if (status !== 'unchanged') {
      const newSnapshot: EntitySnapshotFile = {
        schemaVersion: 2,
        fingerprint: fingerprintWithPrefix,
        projection: projection as unknown as Record<string, unknown>,
        // Preserve frozenSnapshots from the prior file so a re-baseline does
        // not erase Plan 06's per-migration v1/v2 hashes (SNP-03).
        frozenSnapshots: existing?.frozenSnapshots ?? [],
      };
      writeEntitySnapshot(snapPath, newSnapshot);
    }

    summaryRows.push([meta.entityName, meta.modelService, String(meta.modelVersion), `${fingerprint.slice(0, 12)}...`, colorizeStatus(status)]);
  }

  // Update _journal.json. Always rewritten — the canonical-JSON output is
  // byte-deterministic so the unchanged case still satisfies byte-equal
  // CONTENT comparison across runs.
  const journalEntries = allEntities.map((m) => ({
    entity: m.entityName,
    snapshot: relative(paths.root, entitySnapshotPath(cwd, m.entityName)),
  }));
  const newJournal: JournalFile = {
    schemaVersion: 2,
    minSchemaVersion: 1,
    entries: journalEntries,
  };
  writeJournal(paths.journal, newJournal);

  spinner.success(`Baselined ${allEntities.length} entit${allEntities.length === 1 ? 'y' : 'ies'}.`);

  const table = createTable({
    head: ['Entity', 'Service', 'Version', 'Fingerprint', 'Status'],
    rows: summaryRows,
  });
  // cli-table3 output is the machine-parseable summary — goes to stdout per
  // Plan 05's stderr/stdout discipline (log.* writes to stderr).
  process.stdout.write(`${table.toString()}\n`);
}

function colorizeStatus(status: SnapshotStatus): string {
  switch (status) {
    case 'new':
      return c.ok(status);
    case 'updated':
      return c.warn(status);
    case 'unchanged':
      return c.dim(status);
  }
}

/**
 * Register the `baseline` subcommand on the commander program. No
 * subcommand-specific flags — `baseline` reads the global `--config` from
 * the program's options.
 */
export function registerBaselineCommand(program: Command): void {
  program
    .command('baseline')
    .description('Snapshot all current entity shapes (idempotent; safe for adoption on a live project)')
    .action(async () => {
      try {
        const configFlag = program.opts<{ config?: string }>().config;
        await runBaseline({
          cwd: process.cwd(),
          ...(configFlag !== undefined ? { configFlag } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const remediation = (err as { remediation?: string }).remediation;
        log.err(message, remediation);
        process.exit(EXIT_CODES.USER_ERROR);
      }
    });
}
