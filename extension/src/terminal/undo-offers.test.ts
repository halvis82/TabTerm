import { describe, expect, it } from 'vitest';
import { UNDO_WINDOW_MS, UndoStack, offerLabel } from './undo-offers.js';

const offer = (sessionId: string, at = 0, kind: 'closed' | 'detached' = 'closed') => ({
  sessionId,
  kind,
  title: `/Users/me/${sessionId}`,
  at,
});

describe('what can still be brought back', () => {
  it('offers the most recent first, which is what Command+Z means', () => {
    const stack = new UndoStack();
    stack.setDepth(4);
    stack.push(offer('a', 1000));
    stack.push(offer('b', 2000));
    expect(stack.next(2100)?.sessionId).toBe('b');
  });

  it('keeps as many as the tab had panes, and no more', () => {
    const stack = new UndoStack();
    stack.setDepth(2);
    stack.push(offer('a', 1000));
    stack.push(offer('b', 1100));
    stack.push(offer('c', 1200));
    expect(stack.live(1300).map((o) => o.sessionId)).toEqual(['c', 'b']);
  });

  it('replaces rather than repeats when the same terminal is offered twice', () => {
    // Two buttons for one terminal, the second of which cannot work, is worse than one.
    const stack = new UndoStack();
    stack.setDepth(4);
    stack.push(offer('a', 1000));
    stack.push(offer('a', 2000));
    expect(stack.live(2100)).toHaveLength(1);
    expect(stack.live(2100)[0]?.at).toBe(2000);
  });

  it('forgets one once its window has passed', () => {
    const stack = new UndoStack();
    stack.setDepth(4);
    stack.push(offer('a', 0));
    expect(stack.next(UNDO_WINDOW_MS - 1)?.sessionId).toBe('a');
    expect(stack.next(UNDO_WINDOW_MS + 1)).toBeUndefined();
  });

  it('drops one that was taken, so it cannot be taken twice', () => {
    const stack = new UndoStack();
    stack.setDepth(4);
    stack.push(offer('a', 1000));
    stack.remove('a');
    expect(stack.next(1100)).toBeUndefined();
  });

  it('expires the old one while keeping the newer one', () => {
    const stack = new UndoStack();
    stack.setDepth(4);
    stack.push(offer('old', 0));
    stack.push(offer('new', UNDO_WINDOW_MS - 1000));
    expect(stack.live(UNDO_WINDOW_MS + 500).map((o) => o.sessionId)).toEqual(['new']);
  });
});

describe('what the button says', () => {
  it('names the folder rather than the gesture', () => {
    expect(offerLabel(offer('a'))).toBe('Reopen a');
    expect(offerLabel({ ...offer('a'), kind: 'detached' })).toBe('Move a back');
  });

  it('writes the home directory the way a shell does', () => {
    // Its last part is the account name, and "Reopen halvis82" names a person, not a place.
    expect(offerLabel({ ...offer('a'), title: '/Users/me' }, '/Users/me')).toBe('Reopen ~');
  });

  it('says something sensible when there is no folder to name', () => {
    expect(offerLabel({ ...offer('a'), title: '' })).toBe('Reopen the pane');
    expect(offerLabel({ ...offer('a'), title: '', kind: 'detached' })).toBe('Move it back');
  });
});
