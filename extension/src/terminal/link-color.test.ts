import { describe, it, expect } from 'vitest';
import { linkColorFor, looksBlue, LINK_BLUE, LINK_RED } from './link-color.js';

const rgb = (r: number, g: number, b: number) => ({
  isDefault: false,
  isPalette: false,
  color: (r << 16) | (g << 8) | b,
});

describe('what color a path takes under the pointer', () => {
  it('is blue on ordinary text', () => {
    expect(linkColorFor(null)).toBe(LINK_BLUE);
    expect(linkColorFor({ isDefault: true, isPalette: false, color: 0 })).toBe(LINK_BLUE);
    expect(linkColorFor(rgb(220, 220, 220))).toBe(LINK_BLUE);
  });

  it('is red on text that is already blue', () => {
    // The exact color an agent prints a saved path in, taken from a real transcript.
    expect(linkColorFor(rgb(177, 185, 249))).toBe(LINK_RED);
    expect(linkColorFor({ isDefault: false, isPalette: true, color: 12 })).toBe(LINK_RED);
  });

  it('does not call a dark navy blue, since nothing there is readable anyway', () => {
    expect(looksBlue(0, 0, 60)).toBe(false);
  });

  it('does not call green or red or gray blue', () => {
    expect(looksBlue(120, 220, 120)).toBe(false);
    expect(looksBlue(230, 90, 90)).toBe(false);
    expect(looksBlue(180, 180, 180)).toBe(false);
  });

  it('leaves a palette color that is not blue alone', () => {
    expect(linkColorFor({ isDefault: false, isPalette: true, color: 2 })).toBe(LINK_BLUE);
  });
});
