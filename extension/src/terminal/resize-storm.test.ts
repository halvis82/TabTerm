import { describe, expect, it } from 'vitest';
import {
  HISTORY_MS,
  isResizeStorm,
  recordChange,
  RESIZE_WINDOW_MS,
  type SizeChange,
} from './resize-storm.js';

const at = (i: number): number => 1_800_000_000_000 + i * 100;
/** When the run ended, which is when the question would really be asked. */
const endOf = (changes: readonly SizeChange[]): number => changes[changes.length - 1]?.at ?? 0;
const run = (sizes: [number, number][]): SizeChange[] =>
  sizes.map(([cols, rows], i) => ({ at: at(i), cols, rows }));

/** Two sizes alternating, which is what a measurement feeding its own input looks like. */
const oscillating = (times: number): SizeChange[] =>
  run(
    Array.from({ length: times }, (_, i): [number, number] =>
      i % 2 === 0 ? [195, 44] : [195, 43],
    ),
  );

describe('telling a resize loop from somebody dragging the window', () => {
  it('reports the flicker that was actually reported, at the rate it was reported at', () => {
    // Five a second for two seconds, between two sizes. The first version of this guard wanted
    // six a second, so the fault it exists for went unreported by it.
    expect(RESIZE_WINDOW_MS).toBe(2000);
    expect(isResizeStorm(oscillating(10))).toBe(true);
  });

  it('reports the storm that was measured, which was far worse', () => {
    expect(isResizeStorm(oscillating(162))).toBe(true);
  });

  it('says nothing about a window being dragged, however fast', () => {
    const drag = (times: number, everyMs: number): SizeChange[] =>
      Array.from({ length: times }, (_, i) => ({
        at: 1_800_000_000_000 + i * everyMs,
        cols: 195 - i,
        rows: 44,
      }));
    // Ten a second for two seconds, and a hundred a second for ten. A new size every time.
    const fast = drag(20, 100);
    expect(isResizeStorm(fast, endOf(fast))).toBe(false);
    const long = drag(120, 80);
    expect(isResizeStorm(long, endOf(long))).toBe(false);
  });

  it('reports a flood whatever the sizes are, because no drag reaches that rate', () => {
    // Forty inside the two second window, which is twenty a second. A hand cannot do that.
    const flood = Array.from({ length: 40 }, (_, i) => ({
      at: 1_800_000_000_000 + i * 40,
      cols: 195 - i,
      rows: 44,
    }));
    expect(isResizeStorm(flood, endOf(flood))).toBe(true);
  });

  it('says nothing about the repaint nudge a reattach does, which is deliberate and once', () => {
    /**
     * Taken from a real report, on an ordinary reattach after an extension reload.
     *
     * The nudge is one size down and back, on purpose, to make a full-screen program repaint. It
     * arrived alongside three requests for the size the pane already had, and together they came
     * to six changes among two sizes, which is the shape of a loop. They are not a loop, and the
     * repeats are not changes: the caller does not always know whether anything moved.
     */
    const asRecorded = run([
      [195, 44],
      [195, 44],
      [195, 43],
      [195, 44],
      [195, 44],
      [195, 44],
    ]);
    // What it looked like when every request was recorded, change or not.
    expect(isResizeStorm(asRecorded)).toBe(true);

    let kept: SizeChange[] = [];
    for (const change of asRecorded) kept = recordChange(kept, change);
    expect(kept).toHaveLength(3);
    expect(isResizeStorm(kept)).toBe(false);
  });

  it('forgets what has aged out of the run it keeps', () => {
    const old = { at: 1_800_000_000_000, cols: 100, rows: 40 };
    // Still held inside the slow window, because the slow rule needs it.
    const soon = { at: old.at + RESIZE_WINDOW_MS + 1, cols: 100, rows: 41 };
    expect(recordChange([old], soon)).toEqual([old, soon]);
    const later = { at: old.at + HISTORY_MS + 1, cols: 100, rows: 42 };
    expect(recordChange([old], later)).toEqual([later]);
  });

  it('catches a slow oscillation, which is just as visible and sits under the fast rule', () => {
    // About one a second between two sizes. Four in two seconds is under the fast threshold and
    // always will be: a two second window cannot carry a threshold that low without firing on
    // ordinary work.
    const slow = Array.from({ length: 12 }, (_, i) => ({
      at: 1_800_000_000_000 + i * 900,
      cols: 195,
      rows: i % 2 === 0 ? 44 : 43,
    }));
    expect(isResizeStorm(slow.slice(0, 3), endOf(slow.slice(0, 3)))).toBe(false);
    expect(isResizeStorm(slow, endOf(slow))).toBe(true);
  });

  it('says nothing about ten seconds of a person working', () => {
    // A panel, a split, a font change, a panel again. Several sizes over ten seconds is work.
    const working: SizeChange[] = (
      [
        [195, 44],
        [195, 30],
        [100, 30],
        [100, 44],
        [195, 44],
        [195, 22],
        [140, 22],
        [140, 44],
        [195, 44],
        [195, 30],
      ] as [number, number][]
    ).map(([cols, rows], i) => ({ at: 1_800_000_000_000 + i * 900, cols, rows }));
    expect(isResizeStorm(working, endOf(working))).toBe(false);
  });

  it('says nothing about the ordinary few', () => {
    // Opening a panel, a split, a font change. These are real and are not a loop.
    expect(isResizeStorm(oscillating(2))).toBe(false);
    expect(
      isResizeStorm(
        run([
          [195, 44],
          [195, 30],
          [100, 30],
          [100, 44],
          [195, 44],
        ]),
      ),
    ).toBe(false);
  });

  it('needs both few sizes and many changes, not either', () => {
    // Two sizes seen twice is a split being opened and closed, not a loop.
    expect(isResizeStorm(oscillating(4))).toBe(false);
  });
});
