import { describe, expect, it } from 'vitest';
import { linesWithContent } from './screen-content.js';

/** A terminal buffer, as much of one as this decision reads. */
const screen = (lines: string[]) => ({
  buffer: {
    active: {
      length: lines.length,
      getLine: (y: number) => ({ translateToString: () => lines[y] ?? '' }),
    },
  },
});

/**
 * This is what tells a tab that has been used from one that has not.
 *
 * Getting it wrong drops somebody into a bare shell instead of the start screen, which is what
 * happened: zsh prints a lone inverse `%` when output did not end in a newline, that counted as
 * a second line, and a refresh took the start screen away and showed a terminal holding a
 * percent sign.
 */
describe('how much is on a terminal screen', () => {
  it('counts a fresh shell as one line', () => {
    expect(linesWithContent(screen(['(base) halvis82@Mac ~ %', '', '']))).toBe(1);
  });

  it('does not count the marker a shell prints for a partial line', () => {
    expect(linesWithContent(screen(['%', '(base) halvis82@Mac ~ %', '']))).toBe(1);
  });

  it('counts real output, so a used tab is still recognised', () => {
    expect(linesWithContent(screen(['hello', '(base) halvis82@Mac ~ %']))).toBe(2);
  });

  it('counts a line that merely contains a percent, because that is output', () => {
    expect(linesWithContent(screen(['done: 50%', '(base) halvis82@Mac ~ %']))).toBe(2);
  });

  it('counts an empty screen as nothing', () => {
    expect(linesWithContent(screen(['', '   ', '']))).toBe(0);
  });

  it('stops at two, since the question is only ever "more than one"', () => {
    expect(linesWithContent(screen(['a', 'b', 'c', 'd', 'e']))).toBe(2);
  });

  it('counts a wrapped prompt as the one line it is', () => {
    /**
     * A shell in a narrow pane wraps `(base) name@machine ~ %` onto a second row, and counting
     * that row separately made an untouched shell look like a tab with work in it. The
     * consequence was a start screen that refreshed into a bare terminal, and it only appeared
     * when the window was small enough to wrap.
     */
    const term = {
      buffer: {
        active: {
          length: 3,
          getLine: (y: number) =>
            [
              { translateToString: () => '(base) halvis@machine ~ ', isWrapped: false },
              { translateToString: () => '%', isWrapped: true },
              { translateToString: () => '', isWrapped: false },
            ][y],
        },
      },
    };
    expect(linesWithContent(term)).toBe(1);
  });

  it('still counts two real lines as two', () => {
    const term = {
      buffer: {
        active: {
          length: 2,
          getLine: (y: number) =>
            [
              { translateToString: () => '$ echo hello', isWrapped: false },
              { translateToString: () => 'hello', isWrapped: false },
            ][y],
        },
      },
    };
    expect(linesWithContent(term)).toBeGreaterThan(1);
  });
});
