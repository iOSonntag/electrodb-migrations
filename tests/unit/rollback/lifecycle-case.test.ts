/**
 * Unit tests for `determineLifecycleCase` — RESEARCH §Section 1, lines 1024-1027.
 *
 * RED phase: these tests are written before the implementation exists and are
 * expected to FAIL until Feature 1 (GREEN) is implemented.
 */
import { describe, expect, it } from 'vitest';
import { determineLifecycleCase } from '../../../src/rollback/lifecycle-case.js';

// ---------------------------------------------------------------------------
// Minimal type helpers (mirrors the narrow subset preconditions reads)
// ---------------------------------------------------------------------------

type MigRow = { status: string };
type LockRow = { lockState: string; releaseIds?: ReadonlySet<string> } | null;

// ---------------------------------------------------------------------------
// Test cases — one per truth-table cell (RESEARCH §Section 1 lines 1024-1027)
// ---------------------------------------------------------------------------

describe('determineLifecycleCase', () => {
  it("returns 'case-1' for status='pending' (never applied)", () => {
    const row: MigRow = { status: 'pending' };
    expect(determineLifecycleCase(row, null, 'm-1')).toBe('case-1');
  });

  it("returns 'case-1' for status='failed' with failed lock state", () => {
    const row: MigRow = { status: 'failed' };
    const lock: LockRow = { lockState: 'failed' };
    expect(determineLifecycleCase(row, lock, 'm-1')).toBe('case-1');
  });

  it("returns 'case-2' for status='applied' with no lock row", () => {
    const row: MigRow = { status: 'applied' };
    expect(determineLifecycleCase(row, null, 'm-1')).toBe('case-2');
  });

  it("returns 'case-2' for status='applied' with lockState='free'", () => {
    const row: MigRow = { status: 'applied' };
    const lock: LockRow = { lockState: 'free' };
    expect(determineLifecycleCase(row, lock, 'm-1')).toBe('case-2');
  });

  it("returns 'case-1' for status='applied', lockState='release', releaseIds contains migId (success-path pre-release)", () => {
    const row: MigRow = { status: 'applied' };
    const lock: LockRow = { lockState: 'release', releaseIds: new Set(['m-1']) };
    expect(determineLifecycleCase(row, lock, 'm-1')).toBe('case-1');
  });

  it("returns 'case-2' for status='applied', lockState='release', releaseIds does NOT contain migId", () => {
    const row: MigRow = { status: 'applied' };
    const lock: LockRow = { lockState: 'release', releaseIds: new Set(['m-OTHER']) };
    expect(determineLifecycleCase(row, lock, 'm-1')).toBe('case-2');
  });

  it("returns 'case-2' for status='applied', lockState='release', releaseIds absent (no field)", () => {
    const row: MigRow = { status: 'applied' };
    const lock: LockRow = { lockState: 'release' };
    expect(determineLifecycleCase(row, lock, 'm-1')).toBe('case-2');
  });

  it("returns 'case-3' for status='finalized'", () => {
    const row: MigRow = { status: 'finalized' };
    expect(determineLifecycleCase(row, null, 'm-1')).toBe('case-3');
  });

  it("throws for status='reverted' (should be filtered upstream)", () => {
    const row: MigRow = { status: 'reverted' };
    expect(() => determineLifecycleCase(row, null, 'm-1')).toThrow(
      "Unexpected _migrations.status: reverted",
    );
  });
});
