import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SHORTCUTS,
  actionIdFrom,
  actionShortcutId,
  parseShortcuts,
  prettyKeys,
  whyNot,
} from './page-shortcuts.js';

/**
 * A shortcut you are allowed to choose is one that will actually reach the page.
 *
 * Chrome keeps a set of combinations for itself and simply does not deliver them, so a binding
 * on one of those is a control that silently does nothing while the browser does something else.
 * Somebody who bound Command W to closing a pane would watch their tab close.
 */
describe('which combinations may be bound', () => {
  it('refuses the ones Chrome keeps, and says so', () => {
    expect(whyNot('Meta+W')).toContain('Chrome');
    expect(whyNot('Meta+T')).toContain('Chrome');
    expect(whyNot('Meta+1')).toContain('Chrome');
    expect(whyNot('Shift+Meta+T')).toContain('Chrome');
  });

  it('refuses anything the shell would rather have', () => {
    // A bare key, or one with only Shift, is typed rather than caught.
    expect(whyNot('A')).toContain('shell');
    expect(whyNot('Shift+A')).toContain('shell');
    // Plain Control belongs to the shell entirely: Control C, Control D, Control Z.
    expect(whyNot('Control+C')).toContain('Control');
  });

  it('allows what the product actually ships with', () => {
    for (const shortcut of DEFAULT_PAGE_SHORTCUTS) {
      expect(whyNot(shortcut.keys), `${shortcut.title} is ${shortcut.keys}`).toBeNull();
    }
  });

  it('reads as keys rather than as words', () => {
    expect(prettyKeys('Shift+Meta+D')).toBe('⇧⌘D');
    expect(prettyKeys('')).toBe('not bound');
  });
});

describe('what is stored', () => {
  it('keeps the shipped list and applies what was changed', () => {
    // Not Command Shift J, which is Chrome's downloads, and not Option Command J, which is its console.
    const parsed = parseShortcuts([{ id: 'split-down', keys: 'Alt+Meta+Y' }]);
    expect(parsed.find((s) => s.id === 'split-down')?.keys).toBe('Alt+Meta+Y');
    // Everything else keeps its default rather than vanishing.
    expect(parsed).toHaveLength(DEFAULT_PAGE_SHORTCUTS.length);
  });

  it('drops a stored entry for something that no longer exists', () => {
    const parsed = parseShortcuts([{ id: 'gone', keys: 'Shift+Meta+G' }]);
    expect(parsed.some((s) => s.id === 'gone')).toBe(false);
  });

  it('survives rubbish', () => {
    expect(parseShortcuts(null)).toHaveLength(DEFAULT_PAGE_SHORTCUTS.length);
    expect(parseShortcuts([1, 'x', {}])).toHaveLength(DEFAULT_PAGE_SHORTCUTS.length);
  });

  /**
   * What was allowed when it was stored, judged by the rules as they are now.
   *
   * The list of what may not be bound has grown twice, so binding refusing a combination at the
   * moment it is chosen is not enough on its own: the palette's own default turned out to be
   * Chrome's print dialog, and anybody who had ever rebound anything had that stored and would
   * have kept it forever.
   */
  it('drops a stored key the rules now refuse, and falls back to the shipped one', () => {
    const parsed = parseShortcuts([{ id: 'palette', keys: 'Shift+Meta+P' }]);
    const palette = parsed.find((s) => s.id === 'palette');
    expect(palette?.keys).not.toBe('Shift+Meta+P');
    expect(palette?.keys).toBe(DEFAULT_PAGE_SHORTCUTS.find((d) => d.id === 'palette')?.keys);
  });

  it('refuses a stored key on its own terms, whichever rule it breaks', () => {
    // A bare letter is the other kind: it would be typed into the shell rather than caught here.
    const parsed = parseShortcuts([
      { id: 'split-down', keys: 'Meta+Space' },
      { id: 'split-right', keys: 'D' },
    ]);
    expect(parsed.find((s) => s.id === 'split-down')?.keys).not.toBe('Meta+Space');
    expect(parsed.find((s) => s.id === 'split-right')?.keys).not.toBe('D');
  });

  it('leaves a falling back row unbound rather than putting two on one combination', () => {
    /*
     * The default it would return to can be somebody else's now. Two rows on one combination is
     * a state binding refuses and nothing here should be able to create, so it stays unbound:
     * the settings page shows that, and it can be seen and fixed.
     */
    const paletteDefault = DEFAULT_PAGE_SHORTCUTS.find((d) => d.id === 'palette')?.keys ?? '';
    const parsed = parseShortcuts([
      { id: 'clear-screen', keys: paletteDefault },
      { id: 'palette', keys: 'Shift+Meta+P' },
    ]);
    expect(parsed.find((s) => s.id === 'clear-screen')?.keys).toBe(paletteDefault);
    expect(parsed.find((s) => s.id === 'palette')?.keys).toBe('');
  });

  it('never returns two rows on the same combination, whatever was stored', () => {
    const parsed = parseShortcuts([
      { id: 'split-down', keys: 'Shift+Meta+J' },
      { id: 'split-right', keys: 'Shift+Meta+J' },
    ]);
    const bound = parsed.map((s) => s.keys).filter((k) => k !== '');
    expect(new Set(bound).size).toBe(bound.length);
  });
});

/**
 * A key can be bound to an action somebody made, not only to what ships.
 *
 * One list rather than two, because one list is what makes a clash a question with an answer.
 * Two would need a third thing to compare them, and the first time that was forgotten the same
 * combination would be bound to two different jobs.
 */
describe('keys bound to actions somebody made', () => {
  const actions = [
    { id: 'a1', name: 'run the tests' },
    { id: 'a2', name: 'open the notes' },
  ];

  it('adds a row for each action, unbound until it is bound', () => {
    const parsed = parseShortcuts(undefined, actions);
    expect(parsed).toHaveLength(DEFAULT_PAGE_SHORTCUTS.length + 2);
    expect(parsed.find((s) => s.id === actionShortcutId('a1'))?.keys).toBe('');
    expect(parsed.find((s) => s.id === actionShortcutId('a1'))?.title).toBe('run the tests');
  });

  it('applies a stored key to the action it belongs to', () => {
    // Command Shift N opens an incognito window, which is what this used to ask to store.
    const parsed = parseShortcuts([{ id: actionShortcutId('a2'), keys: 'Alt+Meta+N' }], actions);
    expect(parsed.find((s) => s.id === actionShortcutId('a2'))?.keys).toBe('Alt+Meta+N');
  });

  it('forgets a key bound to an action that has been deleted', () => {
    // Otherwise the combination stays claimed by something that no longer exists, which blocks
    // it for everything else and does nothing at all when pressed.
    const parsed = parseShortcuts(
      [{ id: actionShortcutId('gone'), keys: 'Shift+Meta+G' }],
      actions,
    );
    expect(parsed.some((s) => s.keys === 'Shift+Meta+G')).toBe(false);
  });

  it('says which action an id names, and says nothing for the shipped ones', () => {
    expect(actionIdFrom(actionShortcutId('a1'))).toBe('a1');
    expect(actionIdFrom('split-down')).toBeNull();
  });
});

/**
 * Nothing ships bound to a combination Chrome keeps.
 *
 * `Shift+Meta+W` is Close Window and was the shipped default for closing a pane, so pressing it
 * closed the window and every terminal in it.
 *
 * **A check for exactly this already existed and passed.** It compares each default against the
 * reserved list, and the reserved list did not have Close Window in it. So the check was asking
 * whether a default was one of the combinations somebody had thought of, and the answer was yes.
 * A check against an incomplete list is a check about the list.
 *
 * What is added here is the other half: that two defaults are never the same keys, and that the
 * one that caused this is refused by name, so a shorter list cannot quietly let it back.
 */
describe('what ships bound', () => {
  it('is never a combination Chrome keeps for itself', () => {
    const taken = DEFAULT_PAGE_SHORTCUTS.filter((s) => whyNot(s.keys) !== null).map(
      (s) => `${s.id}=${s.keys}: ${String(whyNot(s.keys))}`,
    );
    expect(taken).toEqual([]);
  });

  it('binds each default to a different combination', () => {
    // Two jobs on one key is a key that does the wrong one, and which is which is not decidable.
    const keys = DEFAULT_PAGE_SHORTCUTS.map((s) => s.keys).filter((k) => k !== '');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('still refuses the one that started this', () => {
    expect(whyNot('Shift+Meta+W')).not.toBe(null);
  });
});

/**
 * The combinations that were missing from the list, found by going through it against what Chrome
 * and macOS actually take.
 *
 * A binding the page can never receive is worse than no binding: the row says it is bound, and
 * pressing it does something else entirely. That is the same reasoning the list already carried
 * for full screen, applied to the rest of them.
 */
describe('what else is taken before the page sees it', () => {
  const refused = (keys: string) => whyNot(keys) !== null;

  it('refuses Chrome zoom, all three of them', () => {
    expect(refused('Meta+-')).toBe(true);
    expect(refused('Meta+=')).toBe(true);
    expect(refused('Meta+0')).toBe(true);
  });

  it('refuses paste without formatting and the system print dialog', () => {
    expect(refused('Shift+Meta+V')).toBe(true);
    expect(refused('Shift+Meta+P')).toBe(true);
  });

  it('refuses the macOS screenshot keys', () => {
    // The ones somebody reaches for by accident while trying to bind something nearby.
    expect(refused('Shift+Meta+3')).toBe(true);
    expect(refused('Shift+Meta+4')).toBe(true);
    expect(refused('Shift+Meta+5')).toBe(true);
  });

  it('refuses what the system takes system-wide', () => {
    expect(refused('Meta+Space')).toBe(true);
    expect(refused('Control+Meta+Space')).toBe(true);
    expect(refused('Alt+Meta+Escape')).toBe(true);
  });

  it('and still allows an ordinary combination that nobody has taken', () => {
    // The list has to keep being a list of what is taken, not a habit of refusing things.
    expect(whyNot('Shift+Meta+Y')).toBeNull();
    expect(whyNot('Alt+Meta+K')).toBeNull();
  });
});

/**
 * Every shipped default, against every rule, rather than against a few remembered cases.
 *
 * The list of what is taken grew by fourteen combinations when it was checked properly, and one
 * shipped default turned out to be among them: the palette was bound to Chrome's system print
 * dialog. A check over the whole set is what found it, and is what keeps the next addition
 * honest.
 */
describe('every default, against every rule', () => {
  it('is allowed, one by one, with the reason if not', () => {
    const refused = DEFAULT_PAGE_SHORTCUTS.filter(
      (s) => s.keys !== '' && whyNot(s.keys) !== null,
    ).map((s) => `${s.id} on ${s.keys}: ${String(whyNot(s.keys))}`);
    expect(refused).toEqual([]);
  });

  it('carries a modifier, so nothing can be typed into the shell by accident', () => {
    const bare = DEFAULT_PAGE_SHORTCUTS.filter(
      (s) => s.keys !== '' && !/Control\+|Alt\+|Meta\+/.test(s.keys),
    );
    expect(bare).toEqual([]);
  });

  it('never takes a plain Control key, which the shell needs', () => {
    // Control C, Control D, Control Z: a terminal that eats one of those is broken.
    const stolen = DEFAULT_PAGE_SHORTCUTS.filter((s) => /^Control\+[A-Za-z]$/.test(s.keys));
    expect(stolen).toEqual([]);
  });

  it('and no two of them are the same keys', () => {
    const bound = DEFAULT_PAGE_SHORTCUTS.filter((s) => s.keys !== '').map((s) => s.keys);
    expect(new Set(bound).size).toBe(bound.length);
  });
});
