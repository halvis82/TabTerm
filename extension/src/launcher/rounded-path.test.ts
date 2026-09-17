import { describe, expect, it } from 'vitest';
import { roundedPath, type Point } from './rounded-path.js';

/** A square, walked clockwise on a screen where y grows downwards. */
const square: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/**
 * The shape a tab of seven panes makes: three columns wide, three rows deep, and the last row
 * holding one card, so the outline turns back on itself at the bottom right.
 */
const notched: Point[] = [
  { x: 0, y: 0 },
  { x: 300, y: 0 },
  { x: 300, y: 200 },
  { x: 100, y: 200 },
  { x: 100, y: 300 },
  { x: 0, y: 300 },
];

describe('an outline with its corners rounded', () => {
  it('draws one arc per corner', () => {
    const arcs = roundedPath(square, 12).match(/A /g) ?? [];
    expect(arcs).toHaveLength(4);
  });

  it('and closes the shape', () => {
    expect(roundedPath(square, 12).trimEnd().endsWith('Z')).toBe(true);
  });

  it('and starts on an edge rather than in a corner', () => {
    // Cut back by the radius along the incoming edge, which for the first corner of this square
    // is the left edge coming up from the bottom.
    expect(roundedPath(square, 12).startsWith('M 0 12')).toBe(true);
  });

  /**
   * The inward corner bends the other way, and nothing has to be told which one it is.
   *
   * A polygon clip drew that corner as a knife edge, which is what was reported. Reading the turn
   * means a shape nobody has thought of yet still comes out right.
   */
  it('bends the inward corner the opposite way to the rest', () => {
    const path = roundedPath(notched, 12);
    const sweeps = [...path.matchAll(/A [\d.]+ [\d.]+ 0 0 (\d)/g)].map((m) => m[1]);
    expect(sweeps).toHaveLength(6);
    expect(sweeps.filter((s) => s === '1')).toHaveLength(5);
    expect(sweeps.filter((s) => s === '0')).toHaveLength(1);
  });

  /*
   * And a corner never eats more than half of either edge it sits on, or two corners of a short
   * edge would want the same pixels and the outline would fold back on itself.
   */
  it('never takes more than half an edge, however large the radius', () => {
    const tight: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const path = roundedPath(tight, 999);
    const radii = [...path.matchAll(/A ([\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.max(...radii)).toBeLessThanOrEqual(5);
  });

  it('and a radius of nothing gives plain corners', () => {
    expect(roundedPath(square, 0)).not.toContain('A ');
  });

  it('and too few points is no shape at all', () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        4,
      ),
    ).toBe('');
  });
});
