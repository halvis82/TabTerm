import { describe, expect, it } from 'vitest';
import { REDRAW_AFTER_AWAY_MS, shouldRedrawAfterAway } from './wake-redraw.js';

const NOW = 1_800_000_000_000;

/**
 * The rule behind repainting a tab that has been away.
 *
 * Checked here because the alternative is a test that waits a minute, and because both wrong
 * answers are real defects: never repainting leaves an agent drawn across a third of the window,
 * and repainting on every glance makes the flicker this product spent a day removing.
 */
describe('when a woken tab is asked to draw itself again', () => {
  it('does nothing for a tab that was never away', () => {
    expect(shouldRedrawAfterAway(0, NOW)).toBe(false);
  });

  it('does nothing for a flick to another tab and back', () => {
    expect(shouldRedrawAfterAway(NOW - 800, NOW)).toBe(false);
    expect(shouldRedrawAfterAway(NOW - 30_000, NOW)).toBe(false);
  });

  it('repaints a tab nobody has looked at for a minute', () => {
    expect(shouldRedrawAfterAway(NOW - REDRAW_AFTER_AWAY_MS, NOW)).toBe(true);
    expect(shouldRedrawAfterAway(NOW - 5 * 60 * 60 * 1000, NOW)).toBe(true);
  });

  it('ignores a clock that went backwards, which happens across a sleep', () => {
    expect(shouldRedrawAfterAway(NOW + 10_000, NOW)).toBe(false);
  });
});
