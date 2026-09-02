/**
 * Remembering where a highlight is.
 *
 * A live highlight is held by an xterm marker, which is tied to one buffer line and moves with it
 * as the scrollback grows. That is exact and is what `highlights.ts` uses while the tab is open.
 * This file is only about the durable half: what gets written down so a highlight survives a
 * reload, when there is no marker left to hold.
 *
 * **The first attempt was wrong and the reason matters.** It recorded "which occurrence of this
 * text, counted from the end of the buffer", chosen because scrollback is trimmed from the front.
 * That reasoning was right about trimming and wrong about what a terminal actually does, which is
 * append, constantly. A shell prompt appears again after every command, and each new copy became
 * the last occurrence, so a highlight on a prompt jumped forward to every later prompt. Counting
 * from the **start** is stable under appending, which is the thing that happens all the time, and
 * unstable only under trimming, which happens when the scrollback fills.
 *
 * A highlight whose occurrence is no longer there is dropped rather than drawn somewhere
 * approximate. Being in the wrong place is worse than being gone: a highlight is a claim about
 * where something is.
 */

export interface Highlight {
  /** The text on one line that is highlighted. A selection over several lines becomes several. */
  text: string;
  /** 0 is the first occurrence of that text in the buffer, 1 the next, and so on. */
  occurrence: number;
  /** CSS color, as a #rrggbb. Drawn translucent, see `highlightStyle`. */
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

/** Which occurrence a place is, counted from the start. -1 when the text is not there. */
export function anchor(lines: readonly string[], row: number, col: number, text: string): number {
  return occurrences(lines, text).findIndex((o) => o.row === row && o.col === col);
}

/** Where a highlight is now, or null when that occurrence is no longer in the buffer. */
export function locate(lines: readonly string[], highlight: Highlight): Placed | null {
  return occurrences(lines, highlight.text)[highlight.occurrence] ?? null;
}

/**
 * Is this color light enough that black reads on it?
 *
 * Relative luminance, the same weighting every contrast tool uses. Above the midpoint means a
 * light background, which wants dark text, and below it the other way around.
 */
export function prefersDarkText(color: string): boolean {
  const hex = color.replace('#', '');
  if (hex.length !== 6) return true;
  const channel = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance =
    0.2126 * linear(channel(0)) + 0.7152 * linear(channel(2)) + 0.0722 * linear(channel(4));
  return luminance > 0.45;
}

/**
 * How a highlight is painted.
 *
 * Translucent, because the decoration sits over the characters and an opaque block hid the text
 * it was pointing at, which is the opposite of what a highlight is for. The text underneath is
 * drawn on the renderer's canvas and cannot be recolored from here, so readability comes from
 * letting it through rather than from choosing a color for it.
 *
 * A thin border in the solid color keeps the highlight visible at low alpha, which matters most
 * on a dark terminal where a 20% wash of a dark color is nearly nothing.
 */
export function highlightStyle(color: string): { background: string; border: string } {
  const hex = color.replace('#', '');
  const rgb = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) || 0);
  const alpha = prefersDarkText(color) ? 0.24 : 0.34;
  return {
    background: `rgba(${rgb.join(', ')}, ${String(alpha)})`,
    border: `rgba(${rgb.join(', ')}, 0.85)`,
  };
}
