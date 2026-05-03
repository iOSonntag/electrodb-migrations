/**
 * Barrel for the user-entities tier — the file-system walker + jiti loader +
 * Entity-metadata extractor that BOTH `baseline` (Plan 08) and `create`
 * (Plan 09) consume.
 *
 * `EDBUserEntityLoadError` IS exported here so command catch-blocks can
 * `instanceof`-test it (or duck-check via `code === 'EDB_USER_ENTITY_LOAD_ERROR'`)
 * to deliver a tailored remediation. It MUST NOT appear in `src/index.ts` —
 * Plan 01 added it to `FORBIDDEN_RUNTIME_KEYS` and the public-surface test
 * enforces absence from `dist/index.cjs` exports.
 */
export { discoverEntityFiles } from './discover.js';
export type { DiscoverEntityFilesArgs } from './discover.js';
export { EDBUserEntityLoadError, loadEntityFile } from './load.js';
export { extractEntityMetadata } from './inspect.js';
export type { EntityMetadata } from './inspect.js';
