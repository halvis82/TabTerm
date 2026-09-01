/**
 * The color under a point on the map.
 *
 * One map, used by every place that picks a color. Hue runs across it and lightness runs down it,
 * with saturation fixed, which is what makes clicking anywhere produce a color somebody would
 * actually use. A full saturation dimension would add a third axis for the sake of colors that
 * are either washed out or indistinguishable on a dark terminal.
 *
 * Lightness stops short of white and of black at both ends. Pure white is unreadable as a
 * highlight behind white text, and pure black is invisible as one.
 */

const TOP_LIGHTNESS = 0.86;
const BOTTOM_LIGHTNESS = 0.24;
const SATURATION = 0.72;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function hslToHex(h: number, s: number, l: number): string {
  // The standard conversion, written out rather than pulled in: it is eight lines and a
  // dependency for eight lines is a dependency to keep updated forever.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(hp) % 6] ?? [0, 0, 0];
  const m = l - c / 2;
  const byte = (v: number): string =>
    Math.round(clamp01(v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r1)}${byte(g1)}${byte(b1)}`;
}

/** Where a click at a fraction across and down the map lands, as a CSS color. */
export function colorAt(fractionX: number, fractionY: number): string {
  const x = clamp01(fractionX);
  const y = clamp01(fractionY);
  const lightness = TOP_LIGHTNESS - y * (TOP_LIGHTNESS - BOTTOM_LIGHTNESS);
  return hslToHex(x * 360, SATURATION, lightness);
}

/** The gradient the map is painted with, so what is drawn and what is picked cannot disagree. */
export function mapBackground(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 12; i++) stops.push(hslToHex((i / 12) * 360, SATURATION, 0.55));
  return [
    `linear-gradient(to bottom, ${hslToHex(0, 0, TOP_LIGHTNESS)}00 0%, ` +
      `${hslToHex(0, 0, TOP_LIGHTNESS)}00 50%, ${hslToHex(0, 0, BOTTOM_LIGHTNESS)}ff 100%)`,
    `linear-gradient(to bottom, ${hslToHex(0, 0, TOP_LIGHTNESS)}ff 0%, ` +
      `${hslToHex(0, 0, TOP_LIGHTNESS)}00 50%)`,
    `linear-gradient(to right, ${stops.join(', ')})`,
  ].join(', ');
}

/**
 * The last few colors, most recent first, without duplicates.
 *
 * Five, because that is about how many distinct colors anybody keeps in play, and because the
 * row has to fit beside a text box in a small pane.
 */
export const RECENT_LIMIT = 5;

export function remember(recents: readonly string[], color: string): string[] {
  return [color, ...recents.filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(
    0,
    RECENT_LIMIT,
  );
}
