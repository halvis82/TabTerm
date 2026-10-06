import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { findMarkers, landingRowFor, nearestMarker, rowForRulerFraction } from './markers.js';

/**
 * A buffer described by what each line's ends look like.
 *
 * `null` is ordinary output; a number is a landmark row painted that color across the whole line
 * with its padding concealed, which is how a landmark is recognized. `{ color, plain: true }` is a
 * row painted the same way by some program, without the concealed padding: an agent's input box.
 */
function fakeTerminal(
  rows: (number | null | { color: number; width?: number; plain?: boolean })[],
  cols = 80,
): Terminal {
  const cell = (color: number | null, concealed = color !== null) => ({
    isBgRGB: () => color !== null,
    getBgColor: () => color ?? 0,
    isInvisible: () => (concealed ? 1 : 0),
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
          if (row.plain === true) return { getCell: () => cell(row.color, false) };
          // A bar narrower than the terminal, which is what a landmark printed before a resize
          // looks like.
          const width = row.width ?? cols;
          return { getCell: (x: number) => cell(x < width ? row.color : null) };
        },
      },
    },
  } as unknown as Terminal;
}

describe('finding landmarks in the scrollback', () => {
  it('finds a bar among ordinary output', () => {
    const found = findMarkers(fakeTerminal([null, null, 0x7aa2f7, null]));
    expect(found).toEqual([{ row: 2, color: 0x7aa2f7, height: 1 }]);
  });

  it('counts a three line bar as one landmark, not three', () => {
    // Otherwise one landmark puts three markers beside the scrollbar for the same place.
    const found = findMarkers(fakeTerminal([null, 0x7aa2f7, 0x7aa2f7, 0x7aa2f7, null]));
    expect(found).toHaveLength(1);
    expect(found[0]?.row).toBe(1);
    expect(found[0]?.height, 'and says how tall it is').toBe(3);
  });

  /**
   * How tall it is now, which after a resize is not how tall it was printed.
   *
   * A landmark is written one column short of the terminal it was printed in, so making the pane
   * narrower re-wraps every one of its lines and three rows become six of uneven length. Reported
   * with a photograph of exactly that: "resizing a session when a marker is placed messes up the
   * marker". The measured height is what lets it be painted over as one band again.
   */
  it('measures a bar that a resize has re-wrapped into more rows', () => {
    const rewrapped = [null, ...Array<number>(6).fill(0x7aa2f7), null];
    const found = findMarkers(fakeTerminal(rewrapped));
    expect(found).toHaveLength(1);
    expect(found[0]?.height).toBe(6);
  });

  it('separates two landmarks of different colors that touch', () => {
    const found = findMarkers(fakeTerminal([0x7aa2f7, 0x8ae2a0]));
    expect(found.map((m) => m.color)).toEqual([0x7aa2f7, 0x8ae2a0]);
  });

  it('separates two landmarks of the same color with output between them', () => {
    const found = findMarkers(fakeTerminal([0x7aa2f7, null, 0x7aa2f7]));
    expect(found.map((m) => m.row)).toEqual([0, 2]);
  });

  /**
   * An agent's input box is a full-width colored row too, and it is not a landmark.
   *
   * Claude Code draws its prompt as a row of `48;2;55;55;55`, and the page used to paint that row
   * as a landmark and then keep painting the response that replaced it. Only concealed padding
   * says landmark; the color alone says nothing.
   */
  it("does not take a program's full-width colored row for a landmark", () => {
    expect(findMarkers(fakeTerminal([null, { color: 0x373737, plain: true }, null]))).toEqual([]);
    const several = [null, { color: 0x373737, plain: true }, { color: 0x373737, plain: true }];
    expect(findMarkers(fakeTerminal(several))).toEqual([]);
  });

  it('extends a landmark into its label row, which shows its label rather than concealing it', () => {
    // The label row begins with concealed padding only when the label is short enough to be
    // centered. A wide label reaches the first cell, and the row still belongs to the bar.
    const found = findMarkers(
      fakeTerminal([null, 0x7aa2f7, { color: 0x7aa2f7, plain: true }, 0x7aa2f7]),
    );
    expect(found).toEqual([{ row: 1, color: 0x7aa2f7, height: 3 }]);
  });

  it("does not let a program's row of the same color grow a landmark it touches", () => {
    // Only the row directly under the bar could be mistaken, and that costs one band on a row
    // that is already that color. A row of another color after it is where the bar ends.
    const found = findMarkers(fakeTerminal([0x7aa2f7, { color: 0x373737, plain: true }]));
    expect(found).toEqual([{ row: 0, color: 0x7aa2f7, height: 1 }]);
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

  /**
   * A jump lands the mark where it can be read, not against the top edge.
   *
   * Two rows of context was enough for a shell, where the mark is on the command line itself. It
   * is not enough for a pane running an agent: the mark is made when Return is pressed, and the
   * cursor is then inside the agent's input box at the bottom of the screen, several rows below
   * the line the prompt ends up on. Landing the mark at the top scrolled the prompt off it, so
   * pressing the marker hid the one thing it was for.
   */
  it('leaves a third of the pane above the mark, so what is above it is readable', () => {
    expect(landingRowFor(100, 45)).toBe(85);
    expect(landingRowFor(100, 30)).toBe(90);
  });

  it('and never scrolls past the top of the buffer', () => {
    expect(landingRowFor(3, 45)).toBe(0);
    expect(landingRowFor(0, 45)).toBe(0);
  });

  it('and keeps two rows of context in a pane too short to have thirds', () => {
    expect(landingRowFor(10, 4)).toBe(8);
    expect(landingRowFor(10, 1)).toBe(8);
  });
});
