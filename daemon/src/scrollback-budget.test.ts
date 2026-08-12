import { describe, expect, it } from 'vitest';
import {
  clampBudget,
  DEFAULT_SCROLLBACK_BYTES,
  linesForBytes,
  MAX_SCROLLBACK_BYTES,
  MIN_SCROLLBACK_BYTES,
  megabytes,
} from './scrollback-budget.js';

describe('the scrollback budget', () => {
  it('refuses a budget too small to hold anything useful', () => {
    expect(clampBudget(1)).toBe(MIN_SCROLLBACK_BYTES);
  });

  it('refuses one that would let a single session eat the machine', () => {
    expect(clampBudget(10 ** 12)).toBe(MAX_SCROLLBACK_BYTES);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampBudget(Number.NaN)).toBe(DEFAULT_SCROLLBACK_BYTES);
  });

  it('converts to lines, since that is what a terminal counts', () => {
    // 5 MB at 90 bytes a line is tens of thousands of lines, well above the old 10000 default.
    expect(linesForBytes(DEFAULT_SCROLLBACK_BYTES)).toBeGreaterThan(50_000);
  });

  it('never converts to a uselessly short buffer', () => {
    expect(linesForBytes(1)).toBeGreaterThanOrEqual(1000);
  });

  it('reports megabytes the way the setting shows them', () => {
    expect(megabytes(5 * 1024 * 1024)).toBe(5);
    expect(megabytes(1.5 * 1024 * 1024)).toBe(1.5);
  });
});
