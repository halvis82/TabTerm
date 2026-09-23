import { describe, expect, it } from 'vitest';
import { WheelRows } from './wheel-rows.js';

describe('turning a scroll into rows', () => {
  it('moves the content by the pixels the pointer moved', () => {
    const wheel = new WheelRows();
    expect(wheel.take(90, 18)).toBe(5);
  });

  /*
   * The part of a row left over is carried. A trackpad sends small deltas, and a scroller that
   * threw the remainder away would move nothing at all for a slow drag, which is the fault this
   * exists to fix.
   */
  it('and carries what is left of a row into the next one', () => {
    const wheel = new WheelRows();
    expect(wheel.take(9, 18)).toBe(0);
    expect(wheel.take(9, 18)).toBe(1);
  });

  it('carries in both directions', () => {
    const wheel = new WheelRows();
    expect(wheel.take(-9, 18)).toBe(0);
    expect(wheel.take(-9, 18)).toBe(-1);
  });

  it('and a remainder from one direction does not survive a turn to the other', () => {
    // Two half rows up and then two half rows down is where it started, not a row either way.
    const wheel = new WheelRows();
    expect(wheel.take(9, 18)).toBe(0);
    expect(wheel.take(-9, 18)).toBe(0);
    expect(wheel.take(-18, 18)).toBe(-1);
  });

  it('is the same however the pixels are divided up', () => {
    const slowly = new WheelRows();
    let rows = 0;
    for (let i = 0; i < 20; i++) rows += slowly.take(18, 18);
    expect(rows).toBe(20);

    const atOnce = new WheelRows();
    expect(atOnce.take(360, 18)).toBe(20);
  });

  it('does nothing when the terminal has no size yet', () => {
    // Dividing by a row height of zero is how a scroll becomes an infinity.
    expect(new WheelRows().take(100, 0)).toBe(0);
  });

  it('and nothing for a scroll of nothing', () => {
    expect(new WheelRows().take(0, 18)).toBe(0);
  });

  it('forgets the remainder when asked', () => {
    const wheel = new WheelRows();
    wheel.take(9, 18);
    wheel.reset();
    expect(wheel.take(9, 18)).toBe(0);
  });
});
