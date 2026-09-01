/**
 * Remembering where a highlight is, without remembering a line number.
 *
 * A row number is wrong the moment anything scrolls off the top of the scrollback, and after a
 * reload the buffer is rebuilt from a snapshot that may not start in the same place. So a
 * highlight is anchored the way a landmark is found: by what it looks like. It records the text
 * it covers and **which occurrence of that text**, counted from the end of the buffer.
 *
 * Counted from the end deliberately. Scrollback is trimmed from the front, so numbering from the
 * front changes every time a line is dropped, while numbering from the end is stable until the
 * highlighted line itself is dropped. At that point it stops being found, which is exactly when
 * it stops being reachable.
 */

export interface Highlight {
  /** The text on one line that is highlighted. A selection over several lines becomes several. */
  text: string;
  /** 1 is the last occurrence of that text in the buffer, 2 the one before it, and so on. */
  fromEnd: number;
  /** CSS color. */
  color: string;
}

export interface Placed {
  row: number;
  col: number;
  length: number;
}

/**
 * Every place this exact text appears, in reading order.
 *
 * Overlapping matches are not counted twice: after a match the search continues past it, which
 * is what a person means by "the third time this appears".
 */
export function occurrences(lines: readonly string[], text: string): Placed[] {
  const found: Placed[] = [];
  if (text === '') return found;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? '';
    let from = 0;
    for (;;) {
      const col = line.indexOf(text, from);
      if (col === -1) break;
      found.push({ row, col, length: text.length });
      from = col + text.length;
    }
  }
  return found;
}

/**
 * Which occurrence a place is, counted from the end.
 *
 * Zero when the text is not there at all, which the caller treats as "do not record this".
 */
export function anchor(lines: readonly string[], row: number, col: number, text: string): number {
  const all = occurrences(lines, text);
  const index = all.findIndex((o) => o.row === row && o.col === col);
  return index === -1 ? 0 : all.length - index;
}

/** Where a highlight is now, or null when its text is no longer in the buffer. */
export function locate(lines: readonly string[], highlight: Highlight): Placed | null {
  const all = occurrences(lines, highlight.text);
  return all[all.length - highlight.fromEnd] ?? null;
}

/**
 * Split a selection into one anchored highlight per line.
 *
 * A highlight is drawn as a run on a single row, because that is what a decoration is, so a
 * selection over four lines is four highlights. Blank pieces are dropped: highlighting the empty
 * remainder of a line would anchor to text that is not there and could never be found again.
 */
export function highlightsForSelection(
  lines: readonly string[],
  pieces: readonly { row: number; col: number; text: string }[],
  color: string,
): Highlight[] {
  const made: Highlight[] = [];
  for (const piece of pieces) {
    const text = piece.text.trimEnd();
    if (text === '') continue;
    const fromEnd = anchor(lines, piece.row, piece.col, text);
    if (fromEnd === 0) continue;
    made.push({ text, fromEnd, color });
  }
  return made;
}

/**
 * Drop a highlight that covers a point, so a second right-click can take one off.
 *
 * Matched by position rather than by identity, because the caller has a click and the model has
 * text. The topmost match wins, which is the one drawn over the point.
 */
export function highlightAt(
  lines: readonly string[],
  highlights: readonly Highlight[],
  row: number,
  col: number,
): Highlight | null {
  for (const h of highlights) {
    const at = locate(lines, h);
    if (!at) continue;
    if (at.row === row && col >= at.col && col < at.col + at.length) return h;
  }
  return null;
}
