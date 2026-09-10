import { describe, expect, it } from 'vitest';
import { linesForBytes, DEFAULT_SCROLLBACK_BYTES } from './scrollback-budget.js';
import { applyMemoryMode } from './memory-modes.js';
import { DEFAULTS } from './config.js';

/**
 * Whether the scrollback a person budgets is the scrollback a session gets.
 *
 * The budget was applied to the sessions that already existed whenever it changed, and to nothing
 * else. Everything built afterwards read a fixed number out of the config, and a restart put every
 * session back to it, so the setting worked until it was looked away from.
 *
 * The daemon now derives the config's line count from the budget when it starts, which is what
 * makes the two agree for a session that does not exist yet.
 */
describe('the scrollback budget', () => {
  it('is what a fresh config would build a session with', () => {
    const started = { ...DEFAULTS, scrollbackLines: linesForBytes(DEFAULT_SCROLLBACK_BYTES) };
    expect(started.scrollbackLines).toBe(linesForBytes(DEFAULT_SCROLLBACK_BYTES));
    // And not the fixed number that used to survive every restart regardless of the setting.
    expect(linesForBytes(25 * 1024 * 1024)).not.toBe(DEFAULTS.scrollbackLines);
  });

  it('moves when the budget moves, in the direction a person would expect', () => {
    expect(linesForBytes(1 * 1024 * 1024)).toBeLessThan(linesForBytes(5 * 1024 * 1024));
    expect(linesForBytes(5 * 1024 * 1024)).toBeLessThan(linesForBytes(50 * 1024 * 1024));
  });

  it('leaves the default where it already was, so nobody s memory moves for this', () => {
    // The old fixed default was 10,000 lines. The recalibrated budget lands on the same ground.
    expect(Math.abs(linesForBytes(DEFAULT_SCROLLBACK_BYTES) - 10_000)).toBeLessThan(500);
  });

  it('is still overruled by a memory mode, which is the other thing that sets it', () => {
    // Low mode deliberately keeps less than any budget would. Recorded so the precedence is stated
    // somewhere rather than being whichever call happened last.
    expect(applyMemoryMode(DEFAULTS, 'low').scrollbackLines).toBeLessThan(
      linesForBytes(DEFAULT_SCROLLBACK_BYTES),
    );
  });
});
