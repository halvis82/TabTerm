import { describe, expect, it } from 'vitest';
import { widthCorrections } from '../../scripts/generate-char-width.mjs';
import { WIDTH_CORRECTIONS } from './char-width-data.js';
import { CURRENT_UNICODE_VERSION, correctedWidth, currentWidths } from './char-width.js';

/**
 * The width table, and the reason it is not xterm's.
 *
 * A program drawing a table pads each cell to a column count it works out itself, against a
 * current width table. A terminal that disagrees puts that padding in the wrong place, which is
 * how an agent's box drawing came out one column short on every row holding a check mark: xterm's
 * built-in table is Unicode 6 and calls U+2705 one column wide, and Unicode 9 made it two.
 */
describe('the current width table', () => {
  it('has not gone stale against the data it was generated from', () => {
    expect(WIDTH_CORRECTIONS.map((r) => [...r])).toEqual(widthCorrections());
  });

  it('leaves the characters that made a table ragged to the addon, which has them right', () => {
    // U+2705 and U+274C are the ones that went one column short, and neither needs correcting:
    // the 2018 table already calls them two columns, and xterm's built-in Unicode 6 one did not.
    // Those rows are fixed by having any table newer than 2011, and the corrections start after.
    expect(correctedWidth(0x2705)).toBeUndefined();
    expect(correctedWidth(0x274c)).toBeUndefined();
  });

  it('leaves a warning sign alone, which is why those rows stayed straight', () => {
    // U+26A0 is a text-default emoji: neutral width, made emoji only by a variation selector.
    // The programs we host count it as one column, and so does xterm. Agreement, so no correction.
    expect(correctedWidth(0x26a0)).toBeUndefined();
  });

  it('covers emoji added after the 2018 table was frozen', () => {
    expect(correctedWidth(0x1fae0)).toBe(2); // melting face, Unicode 14
    expect(correctedWidth(0x1fa77)).toBe(2); // pink heart, Unicode 15
  });

  it('narrows the two characters Unicode later stopped drawing as emoji', () => {
    expect(correctedWidth(0x1f93b)).toBe(1); // modern pentathlon
    expect(correctedWidth(0x1f946)).toBe(1); // rifle
  });

  it('leaves everything it has no opinion about untouched', () => {
    expect(correctedWidth(0x41)).toBeUndefined(); // A
    expect(correctedWidth(0x4e00)).toBeUndefined(); // CJK, already two
  });

  it('is sorted and non-overlapping, which is what makes the search sound', () => {
    let previousEnd = -1;
    for (const [first, last] of WIDTH_CORRECTIONS) {
      expect(first).toBeGreaterThan(previousEnd);
      expect(last).toBeGreaterThanOrEqual(first);
      previousEnd = last;
    }
  });
});

describe('the provider built from it', () => {
  const base = {
    version: '11',
    wcwidth: (cp: number): 0 | 1 | 2 => (cp === 0x300 ? 0 : cp === 0x4e00 ? 2 : 1),
    charProperties(this: { wcwidth(cp: number): 0 | 1 | 2 }, cp: number): number {
      return this.wcwidth(cp);
    },
  };

  it('announces a version of its own rather than the one it was built from', () => {
    expect(currentWidths(base).version).toBe(CURRENT_UNICODE_VERSION);
    expect(CURRENT_UNICODE_VERSION).not.toBe('11');
  });

  it('never turns a zero-width character into a visible one', () => {
    expect(currentWidths(base).wcwidth(0x300)).toBe(0); // combining grave accent
  });

  it('applies a correction where there is one and defers where there is not', () => {
    expect(currentWidths(base).wcwidth(0x1fae0)).toBe(2); // corrected, Unicode 14
    expect(currentWidths(base).wcwidth(0x41)).toBe(1); // deferred
    expect(currentWidths(base).wcwidth(0x4e00)).toBe(2); // deferred
  });

  it('carries the corrections into charProperties, not only into wcwidth', () => {
    // The renderer reads the packed value, not wcwidth. This fails if the rebinding that makes
    // the base derive it from our widths ever stops working.
    expect(currentWidths(base).charProperties(0x1fae0, 0)).toBe(2);
  });
});
