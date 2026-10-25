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

/**
 * From here the name hides what is behind it, which is the only level worth a warning.
 *
 * It was 0.4, which put the warning on Strong and Strongest while both still let the output show
 * through, so the warning said something visibly untrue. Strongest is now nearly solid, and is
 * the one level that really does cover the output.
 */
export const OBSCURING_OPACITY = 0.9;

const OLD_STRONGEST = 0.6;

export const LABEL_OPACITY_KEY = 'tabterm.labelOpacity';
export const LABEL_SCALE_KEY = 'tabterm.labelScale';

/**
 * Bounded, because these reach a stylesheet.
 *
 * Zero is allowed: somebody who wants the name in the bar and not over the pane should be able to
 * say so. The top is just short of solid, since a name at full strength over a terminal is a name
 * instead of a terminal.
 */
export function saneOpacity(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LABEL_OPACITY;
  // What Strongest stored before it became nearly solid, so a choice made then still means it.
  if (n === OLD_STRONGEST) return 0.95;
  return Math.min(0.95, Math.max(0, n));
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
