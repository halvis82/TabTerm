import { describe, expect, it } from 'vitest';
import { flashFrame } from './flash-on-finish.js';

describe('the finish flash', () => {
  it('flashes the whole icon of a tab with one pane', () => {
    expect(flashFrame(['success'], true)).toEqual(['attention']);
    expect(flashFrame(['success'], false)).toEqual(['attention-alt']);
  });

  it('keeps the split icon of a tab with several panes, flashing only the half that finished', () => {
    expect(flashFrame(['running', 'success'], true)).toEqual(['running', 'attention']);
    expect(flashFrame(['failed', 'idle'], false)).toEqual(['attention-alt', 'idle']);
  });

  it('flashes the first half when no half is waiting to be seen', () => {
    expect(flashFrame(['running', 'running'], true)).toEqual(['attention', 'running']);
  });
});
