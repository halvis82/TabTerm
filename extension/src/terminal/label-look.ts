/**
 * How the name drawn over a pane looks, which is a preference rather than a fact.
 *
 * The name is deliberately faint: it says which session this is without competing with what the
 * session is saying. How faint, and how large, is a judgement about a particular screen and a
 * particular pair of eyes, and one number cannot be right for everybody. Asked for as a setting,
 * with the warning that turning it up far enough puts text over the output.
 *
 * Page-local, like the theme, because it is about how this browser draws rather than anything the
 * daemon owns. `chrome.storage` broadcasts, so every tab follows a change without a protocol.
 */

/** What the stylesheet uses when nothing has been chosen. Shown in the settings as the default. */
export const DEFAULT_LABEL_OPACITY = 0.16;
export const DEFAULT_LABEL_SCALE = 1;

/** Beyond this the name stops being a watermark and starts being something to read past. */
export const OBSCURING_OPACITY = 0.4;

export const LABEL_OPACITY_KEY = 'tabterm.labelOpacity';
export const LABEL_SCALE_KEY = 'tabterm.labelScale';

/**
 * Bounded, because these reach a stylesheet.
 *
 * Zero is allowed: somebody who wants the name in the bar and not over the pane should be able to
 * say so. The top is short of solid, since a name at full strength over a terminal is a name
 * instead of a terminal.
 */
export function saneOpacity(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LABEL_OPACITY;
  return Math.min(0.9, Math.max(0, n));
}

export function saneScale(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LABEL_SCALE;
  return Math.min(2, Math.max(0.4, n));
}

/** Whether a chosen opacity is far enough up to be worth warning about. */
export function obscuresOutput(opacity: number): boolean {
  return opacity >= OBSCURING_OPACITY;
}
