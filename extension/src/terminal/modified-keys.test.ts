import { describe, expect, it } from 'vitest';
import { encodeModifiedKey, modifierCode, modifyOtherKeysLevel } from './modified-keys.js';

/**
 * Telling a program which modifier was held, when it has asked to be told.
 *
 * Return is one byte and a modifier that does not change it has nowhere to go, so Shift and Return
 * arrives as a plain carriage return and cannot be told from Return. `modifyOtherKeys` is how a
 * program asks to be told anyway, and xterm.js parses the request and does nothing about it.
 *
 * Found by reading what an agent had actually sent: `CSI > 4 ; 2 m` in the session logs, and a
 * Shift and Return that arrived as a bare carriage return and was taken as "send this".
 */
const ESC = String.fromCharCode(27);
const none = { shift: false, alt: false, ctrl: false, meta: false };

describe('reading the request', () => {
  it('takes the level from the second parameter', () => {
    expect(modifyOtherKeysLevel([4, 2])).toBe(2);
    expect(modifyOtherKeysLevel([4, 1])).toBe(1);
  });

  it('reads the bare form as off, which is how a program turns it off', () => {
    expect(modifyOtherKeysLevel([4])).toBe(0);
    expect(modifyOtherKeysLevel([4, 0])).toBe(0);
  });

  it('ignores a sequence that is not about this at all', () => {
    expect(modifyOtherKeysLevel([1, 2])).toBeNull();
    expect(modifyOtherKeysLevel([])).toBeNull();
  });
});

describe('numbering the modifiers', () => {
  it('is one when none is held, which the protocol reserves for that', () => {
    expect(modifierCode(none)).toBe(1);
  });

  it('adds a bit each, in xterm order', () => {
    expect(modifierCode({ ...none, shift: true })).toBe(2);
    expect(modifierCode({ ...none, alt: true })).toBe(3);
    expect(modifierCode({ ...none, ctrl: true })).toBe(5);
    expect(modifierCode({ ...none, shift: true, alt: true })).toBe(4);
  });
});

describe('encoding a key', () => {
  it('sends Shift and Return the way a program that asked expects it', () => {
    expect(encodeModifiedKey('Enter', { ...none, shift: true }, 2)).toBe(ESC + '[27;2;13~');
  });

  it('sends Option and Return distinguishably from it', () => {
    expect(encodeModifiedKey('Enter', { ...none, alt: true }, 2)).toBe(ESC + '[27;3;13~');
  });

  it('leaves a plain Return exactly as it was', () => {
    // The one that must never change. A bare carriage return is how anything is ever run.
    expect(encodeModifiedKey('Enter', none, 2)).toBeNull();
  });

  it('says nothing when nobody asked', () => {
    // Meaningless to a program that did not request it, and it would arrive as text.
    expect(encodeModifiedKey('Enter', { ...none, shift: true }, 0)).toBeNull();
  });

  it('leaves keys the protocol does not name to the terminal', () => {
    expect(encodeModifiedKey('a', { ...none, shift: true }, 2)).toBeNull();
    expect(encodeModifiedKey('ArrowUp', { ...none, shift: true }, 2)).toBeNull();
  });
});
