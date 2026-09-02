import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEMES, THEME_CHOICES, themeNamed } from './themes.js';

describe('themes', () => {
  it('offers exactly what it defines, so the list cannot drift from the table', () => {
    expect(THEME_CHOICES.map(([value]) => value)).toEqual(Object.keys(THEMES));
  });

  it('falls back rather than leaving a page unpainted', () => {
    expect(themeNamed(undefined)).toBe(THEMES[DEFAULT_THEME]);
    expect(themeNamed('nonsense')).toBe(THEMES[DEFAULT_THEME]);
  });

  it('gives every theme both halves', () => {
    // A terminal is drawn on a canvas the stylesheet cannot reach, so a theme that only had
    // CSS variables would leave the terminal itself on whatever it started with.
    for (const [name, theme] of Object.entries(THEMES)) {
      expect(theme.terminal.background, name).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.terminal.foreground, name).toMatch(/^#[0-9a-f]{6}$/);
      expect(Object.keys(theme.surface).length, name).toBeGreaterThan(4);
    }
  });

  it('gives every theme the same set of surface variables', () => {
    // A missing variable is a half-painted page, which is worse than an ugly one.
    const expected = Object.keys(THEMES[DEFAULT_THEME]?.surface ?? {}).sort();
    for (const [name, theme] of Object.entries(THEMES)) {
      expect(Object.keys(theme.surface).sort(), name).toEqual(expected);
    }
  });

  it('keeps light actually light and dark actually dark', () => {
    const value = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    expect(value(THEMES['light']?.terminal.background ?? '#000')).toBeGreaterThan(200);
    expect(value(THEMES['dark']?.terminal.background ?? '#fff')).toBeLessThan(60);
    expect(value(THEMES['midnight']?.terminal.background ?? '#fff')).toBeLessThan(20);
  });
});
