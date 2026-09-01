import { describe, expect, it } from 'vitest';
import {
  anchor,
  highlightAt,
  highlightsForSelection,
  locate,
  occurrences,
} from './highlight-anchor.js';

const lines = ['npm run build', 'error: no such file', 'npm run build', 'done'];

describe('anchoring a highlight to what it covers', () => {
  it('finds every occurrence in reading order', () => {
    expect(occurrences(lines, 'npm run build')).toEqual([
      { row: 0, col: 0, length: 13 },
      { row: 2, col: 0, length: 13 },
    ]);
  });

  it('does not count an overlapping match twice', () => {
    // "the third time this appears" means what a person means by it.
    expect(occurrences(['aaaa'], 'aa')).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 2, length: 2 },
    ]);
  });

  it('numbers occurrences from the end, so trimming the top does not move them', () => {
    const later = anchor(lines, 2, 0, 'npm run build');
    expect(later).toBe(1);

    // Two lines fall off the front of the scrollback. The anchor still finds the same text.
    const trimmed = lines.slice(2);
    expect(locate(trimmed, { text: 'npm run build', fromEnd: later, color: '#ff0' })).toEqual({
      row: 0,
      col: 0,
      length: 13,
    });
  });

  it('loses a highlight whose line has gone, rather than putting it somewhere else', () => {
    const first = anchor(lines, 0, 0, 'npm run build');
    expect(first).toBe(2);
    // Its own occurrence is the one that was trimmed, so there is no honest place to draw it.
    expect(locate(lines.slice(2), { text: 'npm run build', fromEnd: first, color: '#ff0' })).toBe(
      null,
    );
  });

  it('makes one highlight per line of a selection', () => {
    const made = highlightsForSelection(
      lines,
      [
        { row: 1, col: 0, text: 'error: no such file' },
        { row: 2, col: 0, text: 'npm run build' },
      ],
      '#ffd54a',
    );
    expect(made.map((h) => h.text)).toEqual(['error: no such file', 'npm run build']);
    expect(made.every((h) => h.color === '#ffd54a')).toBe(true);
  });

  it('drops a piece with nothing on it', () => {
    // The empty tail of a line has no text to anchor to and could never be found again.
    expect(highlightsForSelection(lines, [{ row: 3, col: 4, text: '   ' }], '#ffd54a')).toEqual([]);
  });

  it('finds the highlight under a point, so a second click can remove it', () => {
    const made = highlightsForSelection(lines, [{ row: 1, col: 7, text: 'no such' }], '#ffd54a');
    expect(highlightAt(lines, made, 1, 9)?.text).toBe('no such');
    // Just past its end is not on it.
    expect(highlightAt(lines, made, 1, 14)).toBe(null);
    expect(highlightAt(lines, made, 0, 9)).toBe(null);
  });
});
