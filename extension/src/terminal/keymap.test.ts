import { describe, expect, it } from 'vitest';
import { classifyKey, xtermShouldHandle, type KeyInput } from './keymap.js';

const key = (over: Partial<KeyInput>): KeyInput => ({
  key: 'a',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  type: 'keydown',
  hasSelection: false,
  ...over,
});

const kind = (over: Partial<KeyInput>) => classifyKey(key(over)).kind;

describe('control keys belong to the shell', () => {
  it('sends Ctrl+C to the PTY so it interrupts', () => {
    // The single most important key in a terminal. Copying instead would be a bug people
    // would notice within a minute.
    expect(kind({ key: 'c', ctrlKey: true })).toBe('to-pty');
  });

  it.each(['u', 'd', 'z', 'a', 'e', 'w', 'r', 'l'])('sends Ctrl+%s to the PTY', (k) => {
    expect(kind({ key: k, ctrlKey: true })).toBe('to-pty');
  });

  it('sends arrows and tab to the PTY, so history and completion work', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']) {
      expect(kind({ key: k })).toBe('to-pty');
    }
  });

  it('sends plain typing to the PTY', () => {
    expect(kind({ key: 'x' })).toBe('to-pty');
  });

  it('sends Option combinations to the PTY, since Option is Meta here', () => {
    expect(kind({ key: 'b', altKey: true })).toBe('to-pty');
  });
});

describe('command keys never reach the shell', () => {
  it('copies on Command+C when something is selected', () => {
    expect(kind({ key: 'c', metaKey: true, hasSelection: true })).toBe('copy');
  });

  it('does not interrupt on Command+C', () => {
    // The mirror of the Ctrl+C rule, and the reason both are tested together.
    for (const selection of [true, false]) {
      expect(kind({ key: 'c', metaKey: true, hasSelection: selection })).not.toBe('to-pty');
    }
  });

  it('leaves Command+C to the browser when nothing is selected', () => {
    expect(kind({ key: 'c', metaKey: true, hasSelection: false })).toBe('browser');
  });

  it('pastes on Command+V', () => {
    expect(kind({ key: 'v', metaKey: true })).toBe('paste');
  });

  it('selects all and searches', () => {
    expect(kind({ key: 'a', metaKey: true })).toBe('select-all');
    expect(kind({ key: 'f', metaKey: true })).toBe('search');
  });

  it('leaves Command+K to the page, because that opens the command panel', () => {
    // It used to clear the terminal. When the panel took the same key both fired, so opening
    // the panel wiped the scrollback behind it while the button did not.
    expect(kind({ key: 'k', metaKey: true })).toBe('browser');
  });

  it('clears on Shift+Command+K instead', () => {
    expect(kind({ key: 'k', metaKey: true, shiftKey: true })).toBe('clear');
  });

  it('leaves the rest to Chrome rather than swallowing it', () => {
    for (const k of ['w', 't', 'n', '1', 'q', 'r']) {
      expect(kind({ key: k, metaKey: true })).toBe('browser');
    }
  });

  it('is not confused by a capital letter', () => {
    expect(kind({ key: 'C', metaKey: true, shiftKey: true, hasSelection: true })).toBe('copy');
  });
});

describe('what xterm is allowed to handle', () => {
  it('handles exactly the keys meant for the PTY', () => {
    expect(xtermShouldHandle({ kind: 'to-pty' })).toBe(true);
    for (const kind of ['copy', 'paste', 'select-all', 'clear', 'search', 'browser'] as const) {
      expect(xtermShouldHandle({ kind })).toBe(false);
    }
  });

  it('ignores key events that are not a keydown', () => {
    // Acting on both keydown and keypress would double every keystroke.
    expect(kind({ key: 'c', metaKey: true, type: 'keyup', hasSelection: true })).toBe('to-pty');
  });
});
