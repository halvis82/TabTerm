import { describe, expect, it } from 'vitest';
import { keysForClick, type ClickToMove } from './click-to-move.js';

/** A click on the line being edited, with nothing else going on. */
const plain: ClickToMove = {
  column: 10,
  row: 5,
  cursorColumn: 4,
  cursorRow: 5,
  mouseIsTaken: false,
  onAlternateScreen: false,
  selected: false,
  applicationCursorKeys: false,
};

describe('clicking where the cursor should go', () => {
  it('sends one arrow per column, to the right', () => {
    expect(keysForClick(plain)).toBe('[C'.repeat(6));
  });

  it('and to the left', () => {
    expect(keysForClick({ ...plain, column: 1 })).toBe('[D'.repeat(3));
  });

  it('and nothing at all for a click where the cursor already is', () => {
    expect(keysForClick({ ...plain, column: 4 })).toBe('');
  });

  it('speaks the other dialect when the program asked for it', () => {
    // `?1` changes what an arrow key looks like on the wire, and a program that asked for it
    // reads the other form as something else entirely.
    expect(keysForClick({ ...plain, applicationCursorKeys: true })).toBe('OC'.repeat(6));
  });

  /*
   * Everything below is a click this must keep its hands off. Each of them is a case where an
   * arrow key means something other than "move the caret".
   */
  it('stays out of the way of a program that asked for the mouse', () => {
    // That one gets the real report, which says exactly where the click was.
    expect(keysForClick({ ...plain, mouseIsTaken: true })).toBe('');
  });

  it('and of a full-screen program, where an arrow is navigation', () => {
    expect(keysForClick({ ...plain, onAlternateScreen: true })).toBe('');
  });

  it('and of a click that selected something, which was a drag', () => {
    expect(keysForClick({ ...plain, selected: true })).toBe('');
  });

  it('and of a click on any row but the one being typed on', () => {
    // Clicking old output is pointing at it, not asking for the caret to go there.
    expect(keysForClick({ ...plain, row: 2 })).toBe('');
    expect(keysForClick({ ...plain, row: 9 })).toBe('');
  });

  /*
   * And a click a very long way from the cursor sends nothing rather than hundreds of keys. A
   * wrapped line makes the column reachable in theory, and a burst that size is a program being
   * driven rather than a person editing.
   */
  it('and of a click too far away to be an edit', () => {
    expect(keysForClick({ ...plain, column: 4000 })).toBe('');
  });
});
