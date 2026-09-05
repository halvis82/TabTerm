import { describe, expect, it } from 'vitest';
import { ALL_MENU, ICON_MENU, PAGE_MENU } from './icon-menu.js';

/**
 * The menu a right click offers, checked as a value.
 *
 * There is no way to read it back from Chrome: a manifest v3 worker has no `getAll`, so this menu
 * was only ever verified by opening it and looking, which is how it came to be wrong twice.
 */
describe('what a right click offers', () => {
  it('opens a terminal first, so the menu is never a dead end', () => {
    // Chrome's own name sits above all of this and nothing can go higher. This is the first of ours.
    expect(ICON_MENU[0]?.title).toBe('New TabTerm terminal');
  });

  it('launches an agent from the icon, from anywhere, terminal or not', () => {
    expect(ICON_MENU.map((m) => m.title)).toContain('Launch an agent in a new tab');
  });

  it('carries settings, shortcuts and the way out', () => {
    const titles = ICON_MENU.map((m) => m.title);
    expect(titles).toContain('TabTerm settings');
    expect(titles).toContain('Edit keyboard shortcuts');
    expect(titles.some((t) => t.startsWith('End all sessions'))).toBe(true);
  });

  it('asks before ending everything, which the ellipsis says out loud', () => {
    expect(ICON_MENU.find((m) => m.id === 'reset-tabterm')?.title).toMatch(/\.\.\.$/);
  });

  it('keeps the page entries off the icon, where they could not mean anything', () => {
    for (const entry of ICON_MENU) expect(entry.contexts).toEqual(['action']);
    for (const entry of PAGE_MENU) expect(entry.contexts).not.toContain('action');
  });

  it('offers cloning only where a repository could be', () => {
    const clone = PAGE_MENU.find((m) => m.id === 'clone-repo');
    expect(clone?.documentUrlPatterns?.length).toBeGreaterThan(0);
    expect(clone?.documentUrlPatterns?.every((p) => p.startsWith('https://'))).toBe(true);
  });

  it('registers every entry once, with an id of its own', () => {
    const ids = ALL_MENU.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_MENU).toHaveLength(PAGE_MENU.length + ICON_MENU.length);
  });
});
