import { describe, expect, it } from 'vitest';
import { isTypedAtMenu, MenuTyping } from './menu-typing.js';

const ITEMS = ['Copy', 'Paste', 'Name session', 'New pane', 'Clear', 'Close pane'];

describe('picking a menu entry by typing at it', () => {
  it('one letter lands on the first entry that begins with it', () => {
    const typing = new MenuTyping();
    expect(typing.type('n', ITEMS)).toBe(2);
  });

  it('and more letters narrow it', () => {
    // `n` is ambiguous between two entries; `ne` is not.
    const typing = new MenuTyping();
    expect(typing.type('n', ITEMS)).toBe(2);
    expect(typing.type('e', ITEMS)).toBe(3);
  });

  it('matches whatever the case', () => {
    const typing = new MenuTyping();
    expect(typing.type('C', ITEMS)).toBe(0);
  });

  it('drops a letter that matches nothing rather than losing the entry already found', () => {
    // One stray key would otherwise make every later keystroke miss as well, which reads as the
    // whole thing being broken.
    const typing = new MenuTyping();
    expect(typing.type('n', ITEMS)).toBe(2);
    expect(typing.type('z', ITEMS)).toBe(2);
    expect(typing.type('a', ITEMS)).toBe(2);
  });

  it('starts again after a pause, so the next word is its own', () => {
    const typing = new MenuTyping();
    const at = 1_000_000;
    expect(typing.type('c', ITEMS, at)).toBe(0);
    expect(typing.type('p', ITEMS, at + MenuTyping.FORGET_AFTER_MS + 1)).toBe(1);
  });

  it('takes a letter back on a backspace', () => {
    const typing = new MenuTyping();
    typing.type('n', ITEMS);
    typing.type('e', ITEMS);
    expect(typing.backspace(ITEMS)).toBe(2);
  });

  it('never lands on an entry that cannot be chosen', () => {
    // Choosing it would do nothing, and nothing happening reads as the typing being ignored.
    const enabled = [true, false, true, true, true, true];
    const typing = new MenuTyping();
    expect(typing.type('p', ITEMS, Date.now(), enabled)).toBe(-1);
  });

  it('answers nothing for an empty prefix', () => {
    expect(MenuTyping.match('', ITEMS)).toBe(-1);
  });

  it('ignores the leading space a menu label may carry', () => {
    expect(MenuTyping.match('c', ['  Copy'])).toBe(0);
  });
});

describe('which key presses belong to the menu', () => {
  it('takes ordinary characters', () => {
    expect(isTypedAtMenu('n', false, false, false)).toBe(true);
    expect(isTypedAtMenu('N', false, false, false)).toBe(true);
    expect(isTypedAtMenu(' ', false, false, false)).toBe(true);
  });

  it('leaves named keys alone', () => {
    // Those are the menu's own controls, or the page's, and are handled by name.
    expect(isTypedAtMenu('Enter', false, false, false)).toBe(false);
    expect(isTypedAtMenu('ArrowDown', false, false, false)).toBe(false);
    expect(isTypedAtMenu('Escape', false, false, false)).toBe(false);
  });

  it('and leaves a shortcut alone, whichever modifier it uses', () => {
    expect(isTypedAtMenu('c', true, false, false)).toBe(false);
    expect(isTypedAtMenu('c', false, true, false)).toBe(false);
    expect(isTypedAtMenu('c', false, false, true)).toBe(false);
  });
});
