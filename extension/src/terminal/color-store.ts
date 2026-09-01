import { remember } from './color-map.js';

/**
 * The colors somebody reached for last, kept per use and kept across TabTerm.
 *
 * Three separate lists, because the colors are for different jobs. A tint chosen to make a
 * session title readable at low opacity is not a color anybody wants offered as a highlight, and
 * a landmark color is neither. Sharing one list would make each of them worse.
 *
 * In extension storage rather than the daemon, on the same reasoning as layout templates: this
 * describes how a person likes their own view to look, and the daemon owns sessions, not taste.
 */

export type ColorUse = 'title' | 'marker' | 'highlight';

const KEY = 'tabterm.recentColors';

/** What each use starts with before anybody has picked anything. */
export const DEFAULT_COLOR: Record<ColorUse, string> = {
  title: '#9aa1b8',
  marker: '#7aa2f7',
  // Yellow, the way a highlighter is yellow unless you go and get another one.
  highlight: '#ffd54a',
};

const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

function parse(raw: unknown): Record<ColorUse, string[]> {
  const empty: Record<ColorUse, string[]> = { title: [], marker: [], highlight: [] };
  if (typeof raw !== 'object' || raw === null) return empty;
  const source = raw as Record<string, unknown>;
  for (const use of ['title', 'marker', 'highlight'] as const) {
    const list = source[use];
    if (Array.isArray(list)) empty[use] = list.filter(isColor);
  }
  return empty;
}

export async function loadRecentColors(use: ColorUse): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const list = parse(stored[KEY])[use];
    // The default is always offered, so the row is never empty and the usual color is one click
    // away even the first time.
    return list.length > 0 ? list : [DEFAULT_COLOR[use]];
  } catch {
    return [DEFAULT_COLOR[use]];
  }
}

export async function rememberColor(use: ColorUse, color: string): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const all = parse(stored[KEY]);
    all[use] = remember(all[use], color);
    await chrome.storage.local.set({ [KEY]: all });
  } catch {
    // A color that could not be remembered is worth less than the terminal still working.
  }
}
