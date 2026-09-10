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

  it('converts to lines against what a line actually costs the emulator', () => {
    /*
     * The conversion used to be against the size of a line as text, 90 bytes, which is not what
     * the budget bounds: the emulator keeps a row of cells with an attribute each and allocates
     * the row whether or not anything was printed into it. Measured at four widths it is close to
     * 520 bytes and nearly flat, so the setting was understating its own cost about six times.
     *
     * At the default budget that comes to a little over ten thousand lines, which is what sessions
     * were already given by the old fixed default. Pinned here because the point of the change was
     * to make the number honest without moving anybody's memory.
     */
    expect(linesForBytes(DEFAULT_SCROLLBACK_BYTES)).toBeGreaterThan(9_500);
    expect(linesForBytes(DEFAULT_SCROLLBACK_BYTES)).toBeLessThan(11_000);
  });

  it('never converts to a uselessly short buffer', () => {
    expect(linesForBytes(1)).toBeGreaterThanOrEqual(1000);
  });

  it('reports megabytes the way the setting shows them', () => {
    expect(megabytes(5 * 1024 * 1024)).toBe(5);
    expect(megabytes(1.5 * 1024 * 1024)).toBe(1.5);
  });
});
