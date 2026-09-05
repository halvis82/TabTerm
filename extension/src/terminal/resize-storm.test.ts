import { describe, expect, it } from 'vitest';
import { isResizeStorm, RESIZE_WINDOW_MS, type SizeChange } from './resize-storm.js';

const at = (i: number): number => 1_800_000_000_000 + i * 100;
const run = (sizes: [number, number][]): SizeChange[] =>
  sizes.map(([cols, rows], i) => ({ at: at(i), cols, rows }));

/** Two sizes alternating, which is what a measurement feeding its own input looks like. */
const oscillating = (times: number): SizeChange[] =>
  run(
    Array.from({ length: times }, (_, i): [number, number] =>
      i % 2 === 0 ? [195, 44] : [195, 43],
    ),
  );

/** A window being dragged: a new size every time, never returning to one. */
const dragging = (times: number): SizeChange[] =>
  run(Array.from({ length: times }, (_, i): [number, number] => [195 - i, 44]));

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
    expect(isResizeStorm(dragging(20))).toBe(false);
    expect(isResizeStorm(dragging(39))).toBe(false);
  });

  it('reports a flood whatever the sizes are, because no drag reaches that rate', () => {
    expect(isResizeStorm(dragging(40))).toBe(true);
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
