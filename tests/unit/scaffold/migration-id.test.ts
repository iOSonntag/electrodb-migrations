import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigrationId, formatTimestamp, sanitizeSlug } from '../../../src/scaffold/migration-id.js';

describe('sanitizeSlug', () => {
  it('passes through an already-canonical slug', () => {
    expect(sanitizeSlug('add-status')).toBe('add-status');
  });

  it('lowercases mixed-case input and collapses non-alphanumeric runs to "-"', () => {
    expect(sanitizeSlug('Add Status!')).toBe('add-status');
  });

  it('collapses leading/inner/trailing whitespace runs to single "-" and trims', () => {
    expect(sanitizeSlug('  add  status  ')).toBe('add-status');
  });

  it('collapses multiple consecutive "-" runs to a single "-"', () => {
    expect(sanitizeSlug('add--status')).toBe('add-status');
  });

  it('trims leading and trailing "-"', () => {
    expect(sanitizeSlug('---add-status---')).toBe('add-status');
  });

  it('treats underscores as non-alphanumeric (collapses to "-")', () => {
    expect(sanitizeSlug('add_status')).toBe('add-status');
  });

  it('preserves digit characters', () => {
    expect(sanitizeSlug('add status 123')).toBe('add-status-123');
  });

  it('collapses ".." (path-traversal) characters to a single "-"', () => {
    expect(sanitizeSlug('a..b')).toBe('a-b');
  });

  it('throws on empty input', () => {
    expect(() => sanitizeSlug('')).toThrow(/sanitize|empty|alphanumeric/i);
  });

  it('throws when input sanitizes to empty (all non-alphanumeric)', () => {
    expect(() => sanitizeSlug('!!!')).toThrow(/sanitize|empty|alphanumeric/i);
  });
});

describe('formatTimestamp', () => {
  it('returns "19700101000000" for epoch 0', () => {
    expect(formatTimestamp(0)).toBe('19700101000000');
  });

  it('matches the README §4 example: 2026-05-01 08:30:00 UTC', () => {
    expect(formatTimestamp(Date.UTC(2026, 4, 1, 8, 30, 0))).toBe('20260501083000');
  });

  it('zero-pads month, day, hour, minute, and second', () => {
    expect(formatTimestamp(Date.UTC(2026, 0, 5, 3, 4, 5))).toBe('20260105030405');
  });

  it('is independent of process.env.TZ — emits UTC components only', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      // formatTimestamp must use the UTC fields regardless of the process TZ.
      expect(formatTimestamp(Date.UTC(2026, 4, 1, 8, 30, 0))).toBe('20260501083000');
    } finally {
      if (originalTz === undefined) {
        // biome-ignore lint/performance/noDelete: setting `process.env.TZ = undefined` would coerce to the string "undefined" in Node.
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });
});

describe('createMigrationId', () => {
  it('combines timestamp + entityName + sanitized slug with "-" separators', () => {
    const id = createMigrationId({
      entityName: 'User',
      slug: 'add-status',
      clock: () => Date.UTC(2026, 4, 1, 8, 30, 0),
    });
    expect(id).toBe('20260501083000-User-add-status');
  });

  it('preserves entityName casing verbatim (no sanitization)', () => {
    const id = createMigrationId({
      entityName: 'OrderLineItem',
      slug: 'add-tier',
      clock: () => 0,
    });
    expect(id).toBe('19700101000000-OrderLineItem-add-tier');
  });

  it('sanitizes the slug component (lowercase + non-alphanumeric collapse)', () => {
    const id = createMigrationId({
      entityName: 'User',
      slug: 'Add Status!',
      clock: () => 0,
    });
    expect(id).toBe('19700101000000-User-add-status');
  });

  it('uses the injected clock — does NOT call Date.now()', () => {
    const fixed = 1714558200000; // some epoch ms
    const id = createMigrationId({
      entityName: 'User',
      slug: 'add-status',
      clock: () => fixed,
    });
    expect(id).toBe(`${formatTimestamp(fixed)}-User-add-status`);
  });

  it('rejects entityName with forward slash (path traversal)', () => {
    expect(() =>
      createMigrationId({
        entityName: 'User/admin',
        slug: 'add-status',
        clock: () => 0,
      }),
    ).toThrow(/path separators|invalid entityName/i);
  });

  it('rejects entityName with back slash (path traversal)', () => {
    expect(() =>
      createMigrationId({
        entityName: 'User\\admin',
        slug: 'add-status',
        clock: () => 0,
      }),
    ).toThrow(/path separators|invalid entityName/i);
  });

  it('rejects entityName containing ".."', () => {
    expect(() =>
      createMigrationId({
        entityName: '../etc/passwd',
        slug: 'add-status',
        clock: () => 0,
      }),
    ).toThrow(/path separators|invalid entityName/i);
  });

  it('rejects empty entityName', () => {
    expect(() =>
      createMigrationId({
        entityName: '',
        slug: 'add-status',
        clock: () => 0,
      }),
    ).toThrow(/non-empty|empty/i);
  });

  it('rejects empty slug (delegates to sanitizeSlug throw)', () => {
    expect(() =>
      createMigrationId({
        entityName: 'User',
        slug: '',
        clock: () => 0,
      }),
    ).toThrow();
  });

  it('rejects slug that sanitizes to empty', () => {
    expect(() =>
      createMigrationId({
        entityName: 'User',
        slug: '!!!',
        clock: () => 0,
      }),
    ).toThrow();
  });
});

/**
 * TZ guard for the entire migration-id suite — defensive in case any test
 * accidentally leaves process.env.TZ set.
 */
let savedTz: string | undefined;
beforeEach(() => {
  savedTz = process.env.TZ;
});
afterEach(() => {
  if (savedTz === undefined) {
    // biome-ignore lint/performance/noDelete: setting `process.env.TZ = undefined` would coerce to the string "undefined" in Node.
    delete process.env.TZ;
  } else {
    process.env.TZ = savedTz;
  }
});
