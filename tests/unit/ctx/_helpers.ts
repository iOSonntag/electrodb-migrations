/**
 * Shared helpers for Phase 6 ctx unit tests. Mirrors
 * `tests/unit/rollback/_stub-service.ts` for shape and conventions.
 *
 * Provides:
 *   - `makeStubEntity(entityName)` — minimal ElectroDB-shaped stub (schema
 *     property, model.entity, no real DDB calls needed for unit tests)
 *   - `makeStubDocClient()` — minimal DDB DocumentClient stub
 *   - `makeStubMigration(opts)` — Migration-shaped stub with configurable
 *     entityName, reads, id
 *   - `writeTestSnapshot(dir, entityName, fingerprint)` — writes a minimal
 *     `.snapshot.json` to a temp dir so `readEntitySnapshot(...)` succeeds.
 *
 * Phase 6 Plans 06-02 and 06-03 consume these helpers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Build a minimal ElectroDB-shaped stub with `model.entity`, `schema`, and
 * stub read/write methods. The `schema` property is what `createReadOnlyFacade`
 * reads via `(entity as any).schema` to clone the entity.
 *
 * @param entityName - The entity name (written to `model.entity`).
 * @param schema     - Optional custom schema. Defaults to a minimal User-like schema.
 * @returns Minimal entity stub accepted by buildCtx and createReadOnlyFacade.
 */
// biome-ignore lint/suspicious/noExplicitAny: ElectroDB Entity has a 5-param generic; stubs cross the type boundary deliberately.
export function makeStubEntity(entityName: string, schema?: any): { model: { entity: string }; schema: any } {
  return {
    model: { entity: entityName },
    schema: schema ?? {
      model: { entity: entityName, version: '1', service: 'app' },
      attributes: {
        id: { type: 'string', required: true },
        name: { type: 'string', required: true },
      },
      indexes: {
        byId: {
          pk: { field: 'pk', composite: ['id'] },
          sk: { field: 'sk', composite: [] },
        },
      },
    },
  };
}

/**
 * Build a minimal DynamoDB DocumentClient stub. Sufficient for `.params()`
 * calls that don't issue real DDB requests.
 *
 * @returns `{ send: vi.fn() }` cast to `DynamoDBDocumentClient`.
 */
export function makeStubDocClient(): DynamoDBDocumentClient {
  return { send: vi.fn() } as unknown as DynamoDBDocumentClient;
}

/**
 * Build a minimal Migration-shaped stub for use in buildCtx and rollback unit
 * tests. Accepts configurable `id`, `entityName`, and `reads` fields.
 *
 * @param opts.id          - Migration id string. Defaults to `'20260601000099-test'`.
 * @param opts.entityName  - Entity name. Defaults to `'TestEntity'`.
 * @param opts.reads       - Optional reads array (list of entity stubs or real Entities).
 * @returns Minimal Migration-shaped object.
 */
// biome-ignore lint/suspicious/noExplicitAny: Migration has the same generic boundary as Entity.
export function makeStubMigration(opts: { id?: string; entityName?: string; reads?: any[] }): any {
  return {
    id: opts.id ?? '20260601000099-test',
    entityName: opts.entityName ?? 'TestEntity',
    from: makeStubEntity(opts.entityName ?? 'TestEntity'),
    to: makeStubEntity(opts.entityName ?? 'TestEntity'),
    up: async (r: unknown) => r,
    ...(opts.reads !== undefined ? { reads: opts.reads } : {}),
  };
}

/**
 * Write a snapshot file at:
 *   `<dir>/.electrodb-migrations/snapshots/<entityName>.snapshot.json`
 *
 * The JSON shape matches `EntitySnapshotFile` (`{schemaVersion: 1, fingerprint,
 * projection: {}}`) so `readEntitySnapshot(path)` succeeds in tests that
 * exercise the fingerprint validation path.
 *
 * @param dir         - Root directory for the snapshot (e.g. output of `mkdtempSync`).
 *                      MUST be a unique temp directory per test.
 * @param entityName  - Entity name used to construct the file path.
 * @param fingerprint - SHA-256 hex string written as the snapshot fingerprint.
 * @returns Absolute path to the created snapshot file.
 */
export function writeTestSnapshot(dir: string, entityName: string, fingerprint: string): string {
  const snapshotsDir = join(dir, '.electrodb-migrations', 'snapshots');
  mkdirSync(snapshotsDir, { recursive: true });
  const path = join(snapshotsDir, `${entityName}.snapshot.json`);
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 1, fingerprint, projection: {} }, null, 2),
    'utf8',
  );
  return path;
}
