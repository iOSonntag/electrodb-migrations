import { describe, expect, it, vi } from 'vitest';
import { iterateV1Records } from '../../../src/runner/scan-pipeline.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Migration stub whose `from.scan.go` pops pages from the
 * provided queue. Each call returns the next page; `cursor` is 'page-token'
 * when more pages remain, `null` on the last page.
 *
 * `goOptions` accumulates every call's options for assertion.
 */
function makeMigrationStub(pages: Array<Array<Record<string, unknown>>>) {
  const queue = [...pages];
  const goOptions: Array<{ cursor?: string | null; limit?: number }> = [];

  const scanGo = vi.fn(async (opts?: { cursor?: string | null; limit?: number }) => {
    goOptions.push(opts ?? {});
    const page = queue.shift() ?? [];
    const cursor = queue.length > 0 ? 'page-token' : null;
    return { data: page, cursor };
  });

  const migration = {
    from: { scan: { go: scanGo } },
    to: { put: (_record: unknown) => ({ params: vi.fn(async () => ({})) }) },
    id: 'test-migration',
    entityName: 'TestEntity',
    up: async (record: unknown) => record,
  } as unknown as Parameters<typeof iterateV1Records>[0];

  return { migration, scanGo, goOptions };
}

/**
 * Collect all pages yielded by the async generator into an array.
 */
async function collectPages(
  gen: AsyncGenerator<readonly Record<string, unknown>[]>,
): Promise<Array<readonly Record<string, unknown>[]>> {
  const result: Array<readonly Record<string, unknown>[]> = [];
  for await (const page of gen) {
    result.push(page);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('iterateV1Records (scan-pipeline)', () => {
  it('SP-1: single page with cursor=null — yields one page then exits', async () => {
    const { migration, scanGo } = makeMigrationStub([[{ id: 'r1' }, { id: 'r2' }]]);

    const pages = await collectPages(iterateV1Records(migration));

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([{ id: 'r1' }, { id: 'r2' }]);
    // scan.go called exactly once (cursor=null → done after first page)
    expect(scanGo).toHaveBeenCalledTimes(1);
  });

  it('SP-2: multi-page — yields three pages in order', async () => {
    const { migration } = makeMigrationStub([[{ id: 'r1' }], [{ id: 'r2' }], [{ id: 'r3' }]]);

    const pages = await collectPages(iterateV1Records(migration));

    expect(pages).toHaveLength(3);
    expect(pages[0]).toEqual([{ id: 'r1' }]);
    expect(pages[1]).toEqual([{ id: 'r2' }]);
    expect(pages[2]).toEqual([{ id: 'r3' }]);
  });

  it('SP-3: empty page is NOT yielded but cursor IS followed — skips empty first page', async () => {
    // pages[0] is empty → not yielded; pages[1] has data → yielded
    const { migration } = makeMigrationStub([[], [{ id: 'r1' }]]);

    const pages = await collectPages(iterateV1Records(migration));

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([{ id: 'r1' }]);
  });

  it('SP-4: onPage callback runs once per page advance (including empty pages)', async () => {
    // Two pages: first empty, second has records → scan.go called twice → onPage called twice
    const { migration } = makeMigrationStub([[], [{ id: 'r1' }]]);
    const onPage = vi.fn();

    await collectPages(iterateV1Records(migration, { onPage }));

    // onPage fires once per cursor advance regardless of whether records were yielded
    expect(onPage).toHaveBeenCalledTimes(2);
  });

  it('SP-5: explicit pageSize is forwarded as limit to scan.go', async () => {
    const { migration, goOptions } = makeMigrationStub([[{ id: 'r1' }]]);

    await collectPages(iterateV1Records(migration, { pageSize: 5 }));

    expect(goOptions[0]?.limit).toBe(5);
  });
});
