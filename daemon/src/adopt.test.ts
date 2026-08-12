import { describe, expect, it } from 'vitest';
import { prunePanes } from './adopt.js';
import type { LayoutNode } from '@tabterm/shared';

const pane = (sessionId: string): LayoutNode => ({
  type: 'terminal',
  paneId: `p-${sessionId}`,
  sessionId,
});
const split = (a: LayoutNode, b: LayoutNode): LayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  children: [a, b],
});

describe('adopting a layout whose panes may not all have survived', () => {
  it('keeps a pane whose session is still running', () => {
    expect(prunePanes(pane('a'), new Set(['a']))).toEqual(pane('a'));
  });

  it('drops a pane whose session is gone', () => {
    // A pane that can never produce output is worse than an absent pane.
    expect(prunePanes(pane('a'), new Set())).toBe(null);
  });

  it('collapses a split when only one side survived', () => {
    const layout = split(pane('a'), pane('b'));
    expect(prunePanes(layout, new Set(['b']))).toEqual(pane('b'));
  });

  it('keeps both sides when both survived', () => {
    const layout = split(pane('a'), pane('b'));
    expect(prunePanes(layout, new Set(['a', 'b']))).toEqual(layout);
  });

  it('returns nothing when the whole workspace is gone', () => {
    expect(prunePanes(split(pane('a'), pane('b')), new Set())).toBe(null);
  });

  it('collapses nested splits down to what is left', () => {
    const layout = split(split(pane('a'), pane('b')), pane('c'));
    expect(prunePanes(layout, new Set(['b']))).toEqual(pane('b'));
  });
});
