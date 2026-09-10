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

  /**
   * Neither Command+K nor Shift+Command+K is decided here.
   *
   * Both are page shortcuts, chosen in settings, and this table answered for one of them as
   * well. Both fired: clearing ran twice, and the second run saved the already cleared screen as
   * what to put back, so taking a clear back restored a bare prompt. Two owners for one key is a
   * defect whatever the key does.
   */
  it('leaves Command+K and Shift+Command+K to the page, which owns both', () => {
    expect(kind({ key: 'k', metaKey: true })).toBe('browser');
    expect(kind({ key: 'k', metaKey: true, shiftKey: true })).toBe('browser');
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

/**
 * Return, and the difference between finishing and continuing.
 *
 * A program that takes more than one line reads `ESC CR` as another line and a bare `CR` as the end
 * of the input. Option and Return has always produced the first, because Option is Meta here.
 * Command and Return produced nothing: it fell to the arm that hands a key back to Chrome, and
 * Chrome has no use for it either, so the keystroke went nowhere.
 */
describe('Return with a modifier held', () => {
  const press = (over: Partial<Parameters<typeof classifyKey>[0]>) =>
    classifyKey({
      key: 'Enter',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      type: 'keydown',
      hasSelection: false,
      ...over,
    });

  it('is a new line when Shift is held', () => {
    // The one the report was about. A bare CR is how a program is told the input has finished, so
    // Shift and Return submitted the prompt instead of continuing it.
    expect(press({ shiftKey: true }).kind).toBe('newline');
  });

  it("is still the shell's when Option is held", () => {
    // Option is Meta here, so xterm already sends ESC CR for it. Claiming it would be two owners
    // for one key, and the second owner would send the same bytes the first already sends.
    expect(press({ altKey: true }).kind).toBe('to-pty');
  });

  it('is left to Chrome when Command is held', () => {
    // A newline is Shift or Option and Return, which a program asks to be told about. Command and
    // Return is not a terminal key at all, and giving it a meaning here would only make one
    // terminal disagree with every other.
    expect(press({ metaKey: true }).kind).toBe('browser');
  });

  it('is still the end of the input on its own', () => {
    // The one that must not change. A bare Return is how anything is ever run.
    expect(press({}).kind).toBe('to-pty');
  });

  it('is left to the program when Option is held, which already sends the escape', () => {
    // Option is Meta in this terminal, so xterm produces `ESC CR` without help from here.
    expect(press({ altKey: true }).kind).toBe('to-pty');
  });

  it('is left to the shell when Control is held', () => {
    expect(press({ ctrlKey: true }).kind).toBe('to-pty');
  });
});
