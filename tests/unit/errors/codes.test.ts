import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ROLLBACK_REASON_CODES } from '../../../src/errors/codes.js';

describe('ERROR_CODES', () => {
  it('exposes exactly the 7 ERR-02..ERR-08 codes', () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual([
      'LOCK_HELD',
      'MIGRATION_IN_PROGRESS',
      'REQUIRES_ROLLBACK',
      'ROLLBACK_NOT_POSSIBLE',
      'ROLLBACK_OUT_OF_ORDER',
      'SELF_READ_IN_MIGRATION',
      'STALE_ENTITY_READ',
    ]);
  });

  it('every code value uses the EDB_ prefix', () => {
    for (const v of Object.values(ERROR_CODES)) {
      expect(v).toMatch(/^EDB_/);
    }
  });

  it('MIGRATION_IN_PROGRESS is the wire-published ERR-03 code', () => {
    expect(ERROR_CODES.MIGRATION_IN_PROGRESS).toBe('EDB_MIGRATION_IN_PROGRESS');
  });
});

describe('ROLLBACK_REASON_CODES', () => {
  it('exposes the three ERR-05 reason codes', () => {
    expect(ROLLBACK_REASON_CODES).toEqual({
      NO_DOWN_FN: 'no-down-fn',
      NO_RESOLVER: 'no-resolver',
      FINALIZED_ONLY_PROJECTED: 'finalized-only-projected',
    });
  });
});

describe('source-scan invariant: no inline EDB_ literals outside codes.ts', () => {
  // Skip JSDoc comment lines (lines starting with `//`, `/*`, `*`, ` *`)
  // before counting `'EDB_*'` literals — JSDoc text mentioning EDB_* is
  // documentation, not a code value, and would otherwise self-invalidate
  // the gate.
  function countEdbLiterals(path: string): number {
    const src = readFileSync(path, 'utf8');
    return (
      src
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//')) return false;
          if (trimmed.startsWith('/*')) return false;
          if (trimmed.startsWith('*')) return false;
          return true;
        })
        .join('\n')
        .match(/'EDB_[A-Z_]+'/g)?.length ?? 0
    );
  }

  it('classes.ts contains zero inline EDB_ literals', () => {
    const path = resolve(__dirname, '../../../src/errors/classes.ts');
    expect(countEdbLiterals(path)).toBe(0);
  });

  it('checkers.ts contains zero inline EDB_ literals', () => {
    const path = resolve(__dirname, '../../../src/errors/checkers.ts');
    expect(countEdbLiterals(path)).toBe(0);
  });
});
