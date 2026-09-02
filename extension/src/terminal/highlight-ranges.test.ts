import { describe, expect, it } from 'vitest';
import { addOrToggle, connected, merge, rangeAt, sameRange } from './highlight-ranges.js';

const r = (start: number, end: number) => ({ start, end });

describe('highlights on one line', () => {
  it('joins ranges that overlap, so the color does not stack', () => {
    /**
     * The reported bug: highlight "sen", then "ce sent", then "nice senten" and three
     * translucent layers pile up on the overlap, each darker than the last. The colors were
     * stacking because the ranges were not.
     */
    expect(merge([r(10, 13), r(8, 15), r(5, 16)])).toEqual([r(5, 16)]);
  });

  it('joins ranges that only touch, so there is no seam', () => {
    expect(merge([r(0, 4), r(4, 9)])).toEqual([r(0, 9)]);
  });

  it('leaves a gap alone', () => {
    expect(merge([r(0, 4), r(6, 9)])).toEqual([r(0, 4), r(6, 9)]);
  });

  it('takes a highlight off when it is exactly the one that is there', () => {
    expect(addOrToggle([r(4, 9)], r(4, 9))).toEqual([]);
  });

  it('extends when the new one is wider, rather than layering', () => {
    expect(addOrToggle([r(4, 9)], r(2, 12))).toEqual([r(2, 12)]);
  });

  it('extends when the new one only partly overlaps', () => {
    expect(addOrToggle([r(4, 9)], r(7, 14))).toEqual([r(4, 14)]);
  });

  it('adds a separate one when it touches nothing', () => {
    expect(addOrToggle([r(4, 9)], r(20, 24))).toEqual([r(4, 9), r(20, 24)]);
  });

  it('finds the range under a column, and nothing past its end', () => {
    expect(rangeAt([r(4, 9)], 4)).toEqual(r(4, 9));
    expect(rangeAt([r(4, 9)], 8)).toEqual(r(4, 9));
    // The end is exclusive, so the character at it is outside.
    expect(rangeAt([r(4, 9)], 9)).toBe(null);
  });
});

describe('the run of highlight a point belongs to', () => {
  const lines = new Map([
    [0, [r(4, 12)]],
    [1, [r(6, 20)]],
    [2, [r(18, 24)]],
    // Nothing on row 3, so row 4 is a separate block.
    [4, [r(6, 10)]],
  ]);

  it('reaches across rows whose columns overlap', () => {
    // "Continuous with that" is what it looks like: a block of color reaching the point, not
    // whatever happened to be highlighted in the same gesture.
    const run = connected(lines, 0, 6);
    expect(run.map((x) => x.row).sort()).toEqual([0, 1, 2]);
  });

  it('stops at a row with nothing on it', () => {
    expect(connected(lines, 0, 6).some((x) => x.row === 4)).toBe(false);
  });

  it('is empty when the point is not on a highlight', () => {
    expect(connected(lines, 0, 30)).toEqual([]);
    expect(connected(lines, 3, 6)).toEqual([]);
  });

  it('does not join two rows that merely meet at an edge', () => {
    // Side by side on different rows is not one block.
    const edge = new Map([
      [0, [r(0, 5)]],
      [1, [r(5, 9)]],
    ]);
    expect(connected(edge, 0, 2).map((x) => x.row)).toEqual([0]);
  });
});

describe('comparing ranges', () => {
  it('is exact', () => {
    expect(sameRange(r(1, 4), r(1, 4))).toBe(true);
    expect(sameRange(r(1, 4), r(1, 5))).toBe(false);
  });
});
