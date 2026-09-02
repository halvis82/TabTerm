/**
 * The three themes, in one place, for both the interface and the terminal.
 *
 * The setting existed and did nothing. It wrote `data-theme` onto the document root and stored
 * the choice, and **no stylesheet anywhere read that attribute**: a control wired to nothing.
 * Changing it was indistinguishable from the product ignoring you.
 *
 * A terminal is not an ordinary page, so a theme has two halves that have to agree. The
 * interface follows CSS variables. The terminal is drawn by the renderer onto a canvas and takes
 * its colors from xterm's own theme object, which no stylesheet can reach. Both halves come from
 * the same table here so they cannot drift apart.
 */

export interface Theme {
  /** What the terminal itself is painted with. */
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
  };
  /** What everything around it is painted with, as CSS variables on the root. */
  surface: Record<string, string>;
}

export const THEMES: Record<string, Theme> = {
  dark: {
    terminal: {
      background: '#12131a',
      foreground: '#d5d8e2',
      cursor: '#8ab4f8',
      selectionBackground: '#31405e',
    },
    surface: {
      '--bg': '#0f1015',
      '--panel': '#1a1c20',
      '--edge': '#333',
      '--text': '#e8e8e8',
      '--dim': '#9aa1b8',
      '--accent': '#7aa2f7',
      '--hover': '#2b4d7a',
    },
  },
  light: {
    terminal: {
      background: '#fbfbfd',
      foreground: '#1f2430',
      cursor: '#2b6cb0',
      selectionBackground: '#c7d9f5',
    },
    surface: {
      '--bg': '#f2f3f7',
      '--panel': '#ffffff',
      '--edge': '#d3d6de',
      '--text': '#1f2430',
      '--dim': '#5c6478',
      '--accent': '#2b6cb0',
      '--hover': '#dce7f8',
    },
  },
  midnight: {
    terminal: {
      background: '#05060a',
      foreground: '#c8cee0',
      cursor: '#6ee7d5',
      selectionBackground: '#1d2b46',
    },
    surface: {
      '--bg': '#030407',
      '--panel': '#0b0e16',
      '--edge': '#1d2231',
      '--text': '#dfe4f0',
      '--dim': '#79839e',
      '--accent': '#6ee7d5',
      '--hover': '#16304a',
    },
  },
};

export const DEFAULT_THEME = 'dark';

export function themeNamed(name: string | undefined): Theme {
  return THEMES[name ?? ''] ?? (THEMES[DEFAULT_THEME] as Theme);
}

/** The names and labels the settings list offers, derived so the two cannot disagree. */
export const THEME_CHOICES: [value: string, label: string][] = Object.keys(THEMES).map((name) => [
  name,
  name.charAt(0).toUpperCase() + name.slice(1),
]);
