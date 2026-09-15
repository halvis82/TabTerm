import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The page measures its panes once attaching is done, and nothing removes that.
 *
 * The pane's resize observer is what keeps a terminal the size of its box, and it refuses to speak
 * until `attached` is true. During a page load the box settles after the panes exist and before
 * that flag is set: it grew from 1402 to 1463 pixels on one machine, the observer fired, and the
 * correction was dropped.
 *
 * Nothing sent it again, so the session stayed at 187 columns against a real 195 until an
 * unrelated event happened to run a refit. Measured on the daemon: `attach 187x44` at 22:03:39 and
 * `resize-pane 195x44` at 22:05:44, two minutes and five seconds later.
 *
 * For a shell that is a narrow terminal. For a program that redraws over its own last frame it is
 * one table on screen four times at four widths, because every frame drawn in those two minutes is
 * in the history wrapped for 187 and every frame after is wrapped for 195.
 *
 * Checked in the source because the gap only opens on a machine whose layout settles late, which
 * the test browser's does not: it cannot be reproduced here, and the fix is one call that is easy
 * to lose in a refactor.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'terminal-page.ts'),
  'utf8',
);

describe('what happens once a page has attached', () => {
  it('measures its panes again, because what the observer sent before was discarded', () => {
    const after = source.slice(source.indexOf('attached = true;'));
    const soon = after.slice(0, 1600);
    expect(
      soon,
      'a resize seen before attaching is dropped, so the settled size has to be sent here',
    ).toContain('refitAllPanes()');
  });

  it('and a size measured before attaching waits rather than being dropped', () => {
    /**
     * This used to pin the guard that dropped it: `if (size && workspaceId && attached)`.
     *
     * Dropping was safe while a size was sent on every frame of a resize, because a frame that
     * arrived too early was followed by one that did not. Coalescing the resize removed that, so
     * the last frame of a drag can be the one that arrives early, and dropping it leaves a
     * terminal running at a size nothing measured. It waits for the socket now.
     *
     * The refit above is still load bearing and still the thing that covers the first measurement
     * of all, so whoever removes one should still have to look at the other.
     */
    const settles = source.slice(source.indexOf('function sendSizeWhenItSettles'));
    expect(settles.slice(0, 1400)).toContain('sendSizeWhenItSettles(paneId);');
    expect(settles.slice(0, 1400)).toContain('if (!workspaceId || !attached)');
  });
});
