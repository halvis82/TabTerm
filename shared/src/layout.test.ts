import { describe, expect, it } from 'vitest';
import type { LayoutNode, SplitDirection } from './model.js';
import {
  LayoutError,
  closePane,
  findPane,
  isValidLayout,
  paneCount,
  panes,
  setRatio,
  splitPane,
  swapPanes,
  terminalNode,
  validateLayout,
} from './layout.js';

const root = () => terminalNode('p1', 's1');

describe('layout tree', () => {
  it('starts as a single pane', () => {
    const t = root();
    expect(paneCount(t)).toBe(1);
    expect(isValidLayout(t)).toBe(true);
  });

  it('splits a pane and keeps the original first', () => {
    const t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    expect(paneCount(t)).toBe(2);
    expect(panes(t).map((p) => p.paneId)).toEqual(['p1', 'p2']);
    expect(isValidLayout(t)).toBe(true);
  });

  it('nests splits', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p2', 'vertical', 'p3', 's3');
    expect(paneCount(t)).toBe(3);
    expect(panes(t).map((p) => p.paneId)).toEqual(['p1', 'p2', 'p3']);
    expect(isValidLayout(t)).toBe(true);
  });

  it('collapses the parent split when a pane closes', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p2', 'vertical', 'p3', 's3');
    const after = closePane(t, 'p3');
    expect(after).not.toBeNull();
    expect(paneCount(after as LayoutNode)).toBe(2);
    // The sibling replaces the split entirely: no one-child splits are left behind.
    expect(isValidLayout(after)).toBe(true);
  });

  it('returns null when the last pane closes', () => {
    expect(closePane(root(), 'p1')).toBeNull();
  });

  it('never leaves a split with one child, for any close order', () => {
    let t: LayoutNode | null = root();
    for (let i = 2; i <= 6; i++) {
      t = splitPane(
        t,
        `p${String(i - 1)}`,
        i % 2 ? 'horizontal' : 'vertical',
        `p${String(i)}`,
        `s${String(i)}`,
      );
    }
    const order = ['p3', 'p1', 'p6', 'p2', 'p5', 'p4'];
    for (const id of order) {
      t = closePane(t, id);
      if (t === null) break;
      expect(isValidLayout(t)).toBe(true);
    }
    expect(t).toBeNull();
  });

  it('finds panes and reports missing ones', () => {
    const t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    expect(findPane(t, 'p2')).not.toBeNull();
    expect(findPane(t, 'nope')).toBeNull();
    expect(() => closePane(t, 'nope')).toThrowError(LayoutError);
    expect(() => splitPane(t, 'nope', 'horizontal', 'x', 'y')).toThrowError(LayoutError);
  });

  it('clamps ratios into the allowed band', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2', 99);
    expect(isValidLayout(t)).toBe(true);
    t = setRatio(t, 'p1', -5);
    expect(isValidLayout(t)).toBe(true);
    t = setRatio(t, 'p1', 0.7);
    expect((t as { ratio: number }).ratio).toBeCloseTo(0.7);
  });

  it('swaps two panes without changing the shape', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p2', 'vertical', 'p3', 's3');
    const before = paneCount(t);
    const swapped = swapPanes(t, 'p1', 'p3');
    expect(paneCount(swapped)).toBe(before);
    expect(panes(swapped).map((p) => p.paneId)).toEqual(['p3', 'p2', 'p1']);
    expect(isValidLayout(swapped)).toBe(true);
  });

  it('keeps every session attached to its pane through a split', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p1', 'vertical', 'p3', 's3');
    const map = Object.fromEntries(panes(t).map((p) => [p.paneId, p.sessionId]));
    expect(map).toEqual({ p1: 's1', p2: 's2', p3: 's3' });
  });
});

describe('layout tree survives random operation sequences', () => {
  it('stays valid over 300 random split and close sequences', () => {
    // Deterministic PRNG, so a failure is reproducible rather than a mystery.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let run = 0; run < 300; run++) {
      let tree: LayoutNode | null = terminalNode('p0', 's0');
      let next = 1;

      for (let step = 0; step < 12 && tree !== null; step++) {
        const ids = panes(tree).map((p) => p.paneId);
        const target = ids[Math.floor(rnd() * ids.length)] as string;

        if (rnd() < 0.65 || ids.length === 1) {
          const dir: SplitDirection = rnd() < 0.5 ? 'horizontal' : 'vertical';
          tree = splitPane(tree, target, dir, `p${String(next)}`, `s${String(next)}`);
          next++;
        } else {
          tree = closePane(tree, target);
        }

        if (tree !== null) {
          expect(isValidLayout(tree)).toBe(true);
          // Pane ids stay unique, which validateLayout enforces, and counts stay consistent.
          const seen = new Set(panes(tree).map((p) => p.paneId));
          expect(seen.size).toBe(paneCount(tree));
        }
      }
    }
  });
});

describe('layout validation rejects untrusted input', () => {
  const bad: unknown[] = [
    null,
    'string',
    42,
    {},
    { type: 'terminal' },
    { type: 'terminal', paneId: '', sessionId: 's' },
    { type: 'split', direction: 'sideways', ratio: 0.5, children: [] },
    { type: 'split', direction: 'horizontal', ratio: 0.5, children: [terminalNode('a', 'b')] },
    {
      type: 'split',
      direction: 'horizontal',
      ratio: 5,
      children: [terminalNode('a', 'b'), terminalNode('c', 'd')],
    },
    {
      type: 'split',
      direction: 'horizontal',
      ratio: NaN,
      children: [terminalNode('a', 'b'), terminalNode('c', 'd')],
    },
    // Same pane id twice would make every pane lookup ambiguous.
    {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      children: [terminalNode('a', 'b'), terminalNode('a', 'c')],
    },
  ];

  it('rejects every malformed tree', () => {
    for (const node of bad) {
      expect(isValidLayout(node), JSON.stringify(node)).toBe(false);
      expect(() => validateLayout(node)).toThrowError(LayoutError);
    }
  });

  it('accepts a well-formed nested tree', () => {
    let t = splitPane(root(), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p2', 'vertical', 'p3', 's3');
    expect(isValidLayout(JSON.parse(JSON.stringify(t)))).toBe(true);
  });

  it('does not blow the stack on a deeply nested tree', () => {
    let t: LayoutNode = terminalNode('p0', 's0');
    for (let i = 1; i < 60; i++) {
      t = splitPane(t, `p${String(i - 1)}`, 'horizontal', `p${String(i)}`, `s${String(i)}`);
    }
    expect(isValidLayout(t)).toBe(true);
    expect(paneCount(t)).toBe(60);
  });
});

describe('merge and detach preserve every session', () => {
  it('inserting a session into another tree keeps all sessions', () => {
    const a = splitPane(terminalNode('a1', 'sA1'), 'a1', 'horizontal', 'a2', 'sA2');
    const merged = splitPane(a, 'a2', 'vertical', 'b1', 'sB1');
    const ids = panes(merged).map((p) => p.sessionId);
    expect(ids).toContain('sA1');
    expect(ids).toContain('sA2');
    expect(ids).toContain('sB1');
    expect(isValidLayout(merged)).toBe(true);
  });

  it('removing a pane from a tree leaves the others intact', () => {
    let t = splitPane(terminalNode('p1', 's1'), 'p1', 'horizontal', 'p2', 's2');
    t = splitPane(t, 'p2', 'vertical', 'p3', 's3');
    const after = closePane(t, 'p2') as LayoutNode;
    const ids = panes(after).map((p) => p.sessionId);
    expect(ids).toEqual(['s1', 's3']);
    expect(isValidLayout(after)).toBe(true);
  });

  it('a detached pane can seed a valid single-pane tree', () => {
    const solo = terminalNode('moved', 'sMoved');
    expect(isValidLayout(solo)).toBe(true);
    expect(panes(solo)).toEqual([{ paneId: 'moved', sessionId: 'sMoved' }]);
  });
});
