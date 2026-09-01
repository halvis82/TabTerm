import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { findMarkers, nearestMarker, rowForRulerFraction } from './markers.js';

/**
 * A buffer described by what each line's ends look like.
 *
 * `null` is ordinary output; a number is a bar painted that color across the whole line, which is
 * how a landmark is recognized.
 */
function fakeTerminal(
  rows: (number | null | { color: number; width: number })[],
  cols = 80,
): Terminal {
  const cell = (color: number | null) => ({
    isBgRGB: () => color !== null,
    getBgColor: () => color ?? 0,
  });
  return {
    cols,
    buffer: {
      active: {
        length: rows.length,
        baseY: 0,
        cursorY: 0,
        getLine: (y: number) => {
          if (y < 0 || y >= rows.length) return undefined;
          const row = rows[y] ?? null;
          if (row === null) return { getCell: () => cell(null) };
          if (typeof row === 'number') return { getCell: () => cell(row) };
          // A bar narrower than the terminal, which is what a landmark printed before a resize
          // looks like.
          return { getCell: (x: number) => cell(x < row.width ? row.color : null) };
        },
      },
    },
  } as unknown as Terminal;
}

describe('finding landmarks in the scrollback', () => {
  it('finds a bar among ordinary output', () => {
    const found = findMarkers(fakeTerminal([null, null, 0x7aa2f7, null]));
    expect(found).toEqual([{ row: 2, color: 0x7aa2f7 }]);
  });

  it('counts a three line bar as one landmark, not three', () => {
    // Otherwise one landmark puts three markers beside the scrollbar for the same place.
    const found = findMarkers(fakeTerminal([null, 0x7aa2f7, 0x7aa2f7, 0x7aa2f7, null]));
    expect(found).toHaveLength(1);
    expect(found[0]?.row).toBe(1);
  });

  it('separates two landmarks of different colors that touch', () => {
    const found = findMarkers(fakeTerminal([0x7aa2f7, 0x8ae2a0]));
    expect(found.map((m) => m.color)).toEqual([0x7aa2f7, 0x8ae2a0]);
  });

  it('separates two landmarks of the same color with output between them', () => {
    const found = findMarkers(fakeTerminal([0x7aa2f7, null, 0x7aa2f7]));
    expect(found.map((m) => m.row)).toEqual([0, 2]);
  });

  it('ignores ordinary output entirely', () => {
    expect(findMarkers(fakeTerminal([null, null, null]))).toEqual([]);
  });

  it('finds a bar printed before the terminal was widened', () => {
    // A bar is printed at the width the session had at the time, so requiring the last column
    // to match missed every landmark printed before a resize.
    const found = findMarkers(fakeTerminal([{ color: 0x7aa2f7, width: 80 }], 120));
    expect(found).toHaveLength(1);
  });

  it('does not mistake a short colored run for a bar', () => {
    expect(findMarkers(fakeTerminal([{ color: 0x7aa2f7, width: 6 }], 120))).toEqual([]);
  });

  it('refuses to treat a narrow terminal as full of bars', () => {
    // Below a sensible width, a colored run is not distinguishable from a bar.
    expect(findMarkers(fakeTerminal([0x7aa2f7], 4))).toEqual([]);
  });
});

describe('jumping from a marker beside the scrollbar', () => {
  it('maps the top of the ruler to the top of the buffer', () => {
    expect(rowForRulerFraction(0, 100)).toBe(0);
  });

  it('maps the bottom to the last line', () => {
    expect(rowForRulerFraction(1, 100)).toBe(99);
  });

  it('clamps a click outside the ruler rather than scrolling nowhere', () => {
    expect(rowForRulerFraction(-0.4, 100)).toBe(0);
    expect(rowForRulerFraction(2, 100)).toBe(99);
  });

  it('goes to the nearest landmark, so a click beside one still works', () => {
    const markers = [
      { row: 10, color: 1 },
      { row: 400, color: 2 },
    ];
    expect(nearestMarker(markers, 380)?.row).toBe(400);
    expect(nearestMarker(markers, 30)?.row).toBe(10);
  });

  it('has nothing to go to when there are no landmarks', () => {
    expect(nearestMarker([], 5)).toBeNull();
  });
});
