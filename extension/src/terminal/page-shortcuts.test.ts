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
    const parsed = parseShortcuts([{ id: 'split-down', keys: 'Shift+Meta+J' }]);
    expect(parsed.find((s) => s.id === 'split-down')?.keys).toBe('Shift+Meta+J');
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
    const parsed = parseShortcuts([{ id: actionShortcutId('a2'), keys: 'Shift+Meta+N' }], actions);
    expect(parsed.find((s) => s.id === actionShortcutId('a2'))?.keys).toBe('Shift+Meta+N');
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
