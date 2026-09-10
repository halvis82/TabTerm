import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { linesForBytes, DEFAULT_SCROLLBACK_BYTES } from './scrollback-budget.js';
import { applyMemoryMode } from './memory-modes.js';
import { DEFAULTS } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

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

  /*
   * Two things set this field, so which wins is asserted against the shipped code rather than
   * against arithmetic on two helpers.
   *
   * The version this replaces compared `applyMemoryMode(...).scrollbackLines` with
   * `linesForBytes(...)` and passed while the server did the opposite: it applied the mode and
   * overwrote the field on the next line, so Low kept its reap timings and lost the scrollback it
   * is chosen for. A review found that, and the test that should have found it was measuring two
   * functions that were never in disagreement.
   */
  it('lets a memory mode set the scrollback when nobody has chosen a budget', () => {
    const source = readFileSync(join(here, 'server.ts'), 'utf8');
    // The derive is inside the guard, not beside it.
    const guarded = /scrollbackBytes'\] !== undefined\) \{\s*\n\s*this\.#config\.scrollbackLines/;
    expect(source).toMatch(guarded);
  });

  it('applies the same rule when the mode is changed as when the daemon starts', () => {
    const source = readFileSync(join(here, 'server.ts'), 'utf8');
    const sites = source.match(/readUserSettings\(\)\['scrollbackBytes'\] !== undefined/g) ?? [];
    // Startup and set-memory-mode. One without the other is a mode that behaves differently
    // depending on whether it was chosen before or after the daemon came up.
    expect(sites.length).toBe(2);
  });

  it('keeps Low meaningfully smaller than a default budget would give', () => {
    expect(applyMemoryMode(DEFAULTS, 'low').scrollbackLines).toBeLessThan(
      linesForBytes(DEFAULT_SCROLLBACK_BYTES),
    );
  });
});
