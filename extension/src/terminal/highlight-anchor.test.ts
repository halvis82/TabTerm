import { describe, expect, it } from 'vitest';
import {
  anchor,
  highlightStyle,
  locate,
  occurrences,
  prefersDarkText,
} from './highlight-anchor.js';

const lines = ['npm run build', 'error: no such file', 'npm run build', 'done'];

describe('finding a highlight again after a reload', () => {
  it('finds every occurrence in reading order', () => {
    expect(occurrences(lines, 'npm run build')).toEqual([
      { row: 0, col: 0, length: 13 },
      { row: 2, col: 0, length: 13 },
    ]);
  });

  it('does not count an overlapping match twice', () => {
    expect(occurrences(['aaaa'], 'aa')).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 2, length: 2 },
    ]);
  });

  it('numbers occurrences from the start, so later output cannot steal one', () => {
    /**
     * This is the bug the first version had. Counting from the **end** was chosen because
     * scrollback is trimmed from the front, and it was wrong about what a terminal actually
     * does: it appends. A shell prompt appears again after every command, so a highlight on one
     * prompt jumped forward to every later prompt.
     */
    const first = anchor(lines, 0, 0, 'npm run build');
    expect(first).toBe(0);

    // The command runs again and prints the same line. The anchor does not move.
    const later = [...lines, 'npm run build'];
    expect(locate(later, { text: 'npm run build', occurrence: first, color: '#ff0' })).toEqual({
      row: 0,
      col: 0,
      length: 13,
    });
  });

  it('keeps the second occurrence the second, however much is appended', () => {
    const second = anchor(lines, 2, 0, 'npm run build');
    expect(second).toBe(1);
    const later = [...lines, 'npm run build', 'npm run build'];
    expect(locate(later, { text: 'npm run build', occurrence: second, color: '#ff0' })?.row).toBe(
      2,
    );
  });

  it('drops a highlight whose occurrence is gone rather than moving it', () => {
    // Being in the wrong place is worse than being gone: a highlight is a claim about where
    // something is.
    expect(locate(['done'], { text: 'npm run build', occurrence: 1, color: '#ff0' })).toBe(null);
  });
});

describe('painting a highlight so the text still reads', () => {
  it('works out whether the color is light or dark', () => {
    expect(prefersDarkText('#ffd54a')).toBe(true);
    expect(prefersDarkText('#f5f5f5')).toBe(true);
    expect(prefersDarkText('#202020')).toBe(false);
    expect(prefersDarkText('#1a3d8f')).toBe(false);
  });

  it('is translucent, because an opaque block hides what it points at', () => {
    const style = highlightStyle('#ffd54a');
    expect(style.background).toMatch(/^rgba\(255, 213, 74, 0\.\d+\)$/);
    const alpha = Number(/, (0\.\d+)\)$/.exec(style.background)?.[1]);
    expect(alpha).toBeLessThan(0.4);
    expect(alpha).toBeGreaterThan(0.15);
  });

  it('keeps a solid edge, so a dark color is still visible at low alpha', () => {
    // A 24% wash of a dark blue on a dark terminal is very nearly nothing on its own.
    expect(highlightStyle('#1a3d8f').border).toBe('rgba(26, 61, 143, 0.85)');
  });

  it('does not fall over on a color it was not given properly', () => {
    expect(highlightStyle('nonsense').background).toMatch(/^rgba\(/);
    expect(prefersDarkText('nope')).toBe(true);
  });
});
