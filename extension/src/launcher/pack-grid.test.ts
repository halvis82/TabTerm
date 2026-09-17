import { describe, expect, it } from 'vitest';
import { packTiles, rowsUsed, type Tile } from './pack-grid.js';

const card: Tile = { columns: 1, rows: 1 };
const pair: Tile = { columns: 2, rows: 1 };
const seven: Tile = { columns: 3, rows: 3 };

/**
 * The arrangement he photographed, which ran one row longer than it had to.
 *
 * Four columns wide. A card, a two pane tab, a card, a seven pane tab three columns wide and three
 * rows deep, and another two pane tab. The browser places in order and only ever backfills a gap
 * with something that comes after it, so the column beside the tall tab stayed empty for all three
 * of its rows and the last pair was pushed onto a row of its own.
 */
describe('packing the list of what is running', () => {
  const asPhotographed: Tile[] = [card, pair, card, seven, pair];

  it('fits that arrangement into four rows rather than five', () => {
    expect(rowsUsed(asPhotographed, 4)).toBe(4);
  });

  it('and nothing overlaps anything else', () => {
    const places = packTiles(asPhotographed, 4);
    const taken = new Set<string>();
    places.forEach((place, at) => {
      const tile = asPhotographed[at] as Tile;
      for (let c = 0; c < tile.columns; c += 1) {
        for (let r = 0; r < tile.rows; r += 1) {
          const cell = `${String(place.column + c)}:${String(place.row + r)}`;
          expect(taken.has(cell), `two tiles on ${cell}`).toBe(false);
          taken.add(cell);
        }
      }
    });
  });

  it('and nothing hangs off the right hand edge', () => {
    const places = packTiles(asPhotographed, 4);
    places.forEach((place, at) => {
      const tile = asPhotographed[at] as Tile;
      expect(place.column + tile.columns - 1).toBeLessThanOrEqual(4);
    });
  });

  /*
   * Order is kept where keeping it costs nothing, which is the trade he asked for: chronological,
   * unless something can be done simply to save a row. Two tiles of the same width therefore stay
   * in the order they arrived.
   */
  it('keeps the order of tiles that fit the same gaps', () => {
    const places = packTiles([card, card, card, card], 4);
    expect(places.map((p) => p.column)).toEqual([1, 2, 3, 4]);
    expect(places.map((p) => p.row)).toEqual([1, 1, 1, 1]);
  });

  it('and gives a tile wider than the grid the whole width rather than dropping it', () => {
    const places = packTiles([{ columns: 5, rows: 1 }, card], 3);
    expect(places[0]).toEqual({ column: 1, row: 1 });
    expect(places[1]).toEqual({ column: 1, row: 2 });
  });

  it('and always terminates when a gap can fit nothing that is left', () => {
    // A one column hole in front of a two column tile: without raising the hole this loops forever.
    expect(rowsUsed([pair, card, pair], 3)).toBeGreaterThan(0);
  });

  it('and puts a single column of cards beside a tall group', () => {
    const places = packTiles([seven, card, card, card], 4);
    expect(places[0]).toEqual({ column: 1, row: 1 });
    expect(places.slice(1).map((p) => p.column)).toEqual([4, 4, 4]);
    expect(places.slice(1).map((p) => p.row)).toEqual([1, 2, 3]);
  });
});
