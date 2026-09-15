import { describe, expect, it } from 'vitest';
import type { LayoutNode } from '@tabterm/shared';
import { claimsContradictLayout } from './attach-claims.js';

const pane = (paneId: string): LayoutNode => ({
  type: 'terminal',
  paneId,
  sessionId: `s-${paneId}`,
});
const sideBySide = (ratio: number, a = 'a', b = 'b'): LayoutNode => ({
  type: 'split',
  direction: 'horizontal',
  ratio,
  children: [pane(a), pane(b)],
});

/**
 * The claim that actually happened, and the ones that must keep working.
 *
 * Taken from a real log rather than invented: a tab whose panes were 116 and 42 columns, which is
 * a divider at about 0.73, and an attach that claimed 116 for both of them.
 */
describe('a set of claimed pane widths, checked against the layout the daemon holds', () => {
  it('catches one size claimed for every pane, which is the fault this exists for', () => {
    const claims = new Map([
      ['a', 116],
      ['b', 116],
    ]);
    expect(claimsContradictLayout(sideBySide(0.73), claims)).toBe(true);
  });

  it('and believes the measurement that replaced it', () => {
    const claims = new Map([
      ['a', 116],
      ['b', 42],
    ]);
    expect(claimsContradictLayout(sideBySide(0.73), claims)).toBe(false);
  });

  it('leaves an even split alone, where equal widths are exactly right', () => {
    const claims = new Map([
      ['a', 80],
      ['b', 80],
    ]);
    expect(claimsContradictLayout(sideBySide(0.5), claims)).toBe(false);
  });

  /*
   * A column is not a pixel and a divider has width, so a real measurement never lands exactly on
   * the recorded ratio. The tolerance has to swallow that without swallowing the fault above.
   */
  it('tolerates the rounding a real measurement always has', () => {
    const claims = new Map([
      ['a', 118],
      ['b', 40],
    ]);
    expect(claimsContradictLayout(sideBySide(0.73), claims)).toBe(false);
  });

  it('says nothing about panes it was not given', () => {
    expect(claimsContradictLayout(sideBySide(0.73), new Map([['a', 116]]))).toBe(false);
    expect(claimsContradictLayout(sideBySide(0.73), new Map())).toBe(false);
  });

  /*
   * Stacked panes are all the same width, so equal claims are correct there and the check must
   * not read a vertical split as a contradiction.
   */
  it('does not mistake stacked panes for a side-by-side split', () => {
    const stacked: LayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.3,
      children: [pane('a'), pane('b')],
    };
    const claims = new Map([
      ['a', 116],
      ['b', 116],
    ]);
    expect(claimsContradictLayout(stacked, claims)).toBe(false);
  });

  it('adds widths across a nested side-by-side split and checks the outer one too', () => {
    const nested: LayoutNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        pane('a'),
        { type: 'split', direction: 'horizontal', ratio: 0.5, children: [pane('b'), pane('c')] },
      ],
    };
    // 100 on the left, 50 and 50 on the right: the outer split really is even.
    const honest = new Map([
      ['a', 100],
      ['b', 50],
      ['c', 50],
    ]);
    expect(claimsContradictLayout(nested, honest)).toBe(false);

    // One size for all three, which makes the outer split 1:2 where the layout says 1:1.
    const oneSizeForAll = new Map([
      ['a', 100],
      ['b', 100],
      ['c', 100],
    ]);
    expect(claimsContradictLayout(nested, oneSizeForAll)).toBe(true);
  });
});
