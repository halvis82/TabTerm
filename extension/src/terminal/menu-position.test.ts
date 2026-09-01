import { describe, expect, it } from 'vitest';
import { placeMenu } from './menu-position.js';

const view = { viewportWidth: 1000, viewportHeight: 800, menuWidth: 200, menuHeight: 300 };

describe('placing a context menu', () => {
  it('opens down and to the right when there is room', () => {
    const at = placeMenu({ ...view, x: 100, y: 100 });
    expect(at).toMatchObject({ left: 100, top: 100, flippedX: false, flippedY: false });
  });

  it('flips left rather than hanging off the right edge', () => {
    // This is the case that made the menu unusable: right-clicking near the right edge put most
    // of it outside the window.
    const at = placeMenu({ ...view, x: 950, y: 100 });
    expect(at.flippedX).toBe(true);
    expect(at.left + view.menuWidth).toBeLessThanOrEqual(1000);
  });

  it('flips up rather than hanging off the bottom edge', () => {
    const at = placeMenu({ ...view, x: 100, y: 780 });
    expect(at.flippedY).toBe(true);
    expect(at.top + view.menuHeight).toBeLessThanOrEqual(800);
  });

  it('flips both ways in the bottom right corner', () => {
    const at = placeMenu({ ...view, x: 990, y: 790 });
    expect(at).toMatchObject({ flippedX: true, flippedY: true });
    expect(at.left + view.menuWidth).toBeLessThanOrEqual(1000);
    expect(at.top + view.menuHeight).toBeLessThanOrEqual(800);
  });

  it('does not flip when the other side has no room either', () => {
    // A menu taller than the window fits nowhere, so it is pinned to the top rather than moved
    // somewhere even worse.
    const at = placeMenu({ ...view, menuHeight: 900, x: 100, y: 700 });
    expect(at.flippedY).toBe(false);
    expect(at.top).toBeGreaterThanOrEqual(0);
  });

  it('keeps a margin from the edges', () => {
    const at = placeMenu({ ...view, x: 0, y: 0, margin: 8 });
    expect(at.left).toBe(8);
    expect(at.top).toBe(8);
  });
});
