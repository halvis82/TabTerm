/**
 * What color a path takes while the pointer is on it.
 *
 * Asked for as blue, and red when the text is already blue. That second half is the point: agent
 * output is full of color, and a path an agent printed is very often already blue, so a link that
 * always went blue was invisible exactly where links matter most.
 *
 * The cell's own color is read from the buffer rather than from the theme, because what matters is
 * what the character looks like right now, not what the palette says the default is.
 */

/** Blue, for a path drawn in anything that is not already blue. */
export const LINK_BLUE = '#4ea1ff';

/** And red, for one that is. */
export const LINK_RED = '#ff5f5f';

/** The palette entries that are blue by name: blue and bright blue. */
const BLUE_PALETTE = new Set([4, 12]);

/**
 * Whether a color reads as blue to a person.
 *
 * Deliberately blunt. It has one job, which is to decide between two link colors, and the cost of
 * being wrong is a link that is the wrong one of two visible colors. Blue has to dominate both
 * other channels, and be bright enough to see, or a dark navy background tint would count.
 */
export function looksBlue(r: number, g: number, b: number): boolean {
  return b > 90 && b > r + 25 && b > g + 10;
}

export interface CellColor {
  /** True when the cell has no color of its own and takes the terminal's default. */
  isDefault: boolean;
  /** True when the color is one of the 256 palette entries rather than a literal RGB value. */
  isPalette: boolean;
  /** A palette index, or a packed 24 bit RGB value. */
  color: number;
}

/** The color to draw a link in, given what the first character of it is drawn in now. */
export function linkColorFor(fg: CellColor | null): string {
  if (!fg || fg.isDefault) return LINK_BLUE;
  if (fg.isPalette) return BLUE_PALETTE.has(fg.color) ? LINK_RED : LINK_BLUE;
  const r = (fg.color >> 16) & 0xff;
  const g = (fg.color >> 8) & 0xff;
  const b = fg.color & 0xff;
  return looksBlue(r, g, b) ? LINK_RED : LINK_BLUE;
}
