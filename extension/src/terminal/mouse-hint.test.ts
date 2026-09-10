import { describe, expect, it } from 'vitest';
import { dragIsTakenByProgram, type MouseMode } from './mouse-hint.js';

/**
 * When to explain that the mouse belongs to the program.
 *
 * A program can ask the terminal for the mouse, and while it has it a drag goes to the program
 * rather than selecting. Holding a modifier overrides that, which is the convention every terminal
 * shares and which nobody is born knowing.
 */
describe('deciding whether a drag needs explaining', () => {
  const bare = { alt: false, shift: false };

  it('says nothing when no program has asked for the mouse', () => {
    expect(dragIsTakenByProgram('none', bare)).toBe(false);
  });

  it('explains for the modes that take a drag', () => {
    for (const mode of ['vt200', 'drag', 'any'] as MouseMode[]) {
      expect(dragIsTakenByProgram(mode, bare), mode).toBe(true);
    }
  });

  it('stays quiet under x10, which only reports a press', () => {
    // A drag still selects under it, so there is nothing to explain.
    expect(dragIsTakenByProgram('x10', bare)).toBe(false);
  });

  it('stays quiet when the person is already holding the override', () => {
    expect(dragIsTakenByProgram('any', { alt: true, shift: false })).toBe(false);
    expect(dragIsTakenByProgram('any', { alt: false, shift: true })).toBe(false);
  });
});
