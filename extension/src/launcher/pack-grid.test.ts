import { describe, expect, it } from 'vitest';
import { packTiles, rowsUsed, type Tile } from './pack-grid.js';

const card: Tile = { columns: 1, rows: 1 };
const pair: Tile = { columns: 2, rows: 1 };
const seven: Tile = { columns: 3, rows: 3, lastRow: 1 };

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
      const last = tile.lastRow ?? tile.columns;
      for (let r = 0; r < tile.rows; r += 1) {
        // The last row of a tab is not always full, and the cells it does not reach belong to
        // whoever the packing gave them to.
        const width = r === tile.rows - 1 ? last : tile.columns;
        for (let c = 0; c < width; c += 1) {
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

  it('and puts cards beside a tall group, including in the notch it leaves', () => {
    const places = packTiles([seven, card, card, card], 4);
    expect(places[0]).toEqual({ column: 1, row: 1 });
    // Two down the free column beside it, and the third into the corner its last row leaves.
    expect(places.slice(1)).toEqual([
      { column: 4, row: 1 },
      { column: 4, row: 2 },
      { column: 2, row: 3 },
    ]);
  });
});

/**
 * A tab whose last row is not full leaves its spare cells to somebody else.
 *
 * Seven panes are three across and three down, and the last row holds one card. Treated as a solid
 * nine cell block it reserved two cells that held nothing, and the terminals that would have fitted
 * were pushed below the hole. "The group should only be the size it actually needs to be."
 */
describe('a tab with a short last row', () => {
  it('lets other cards into the cells its last row does not reach', () => {
    const places = packTiles([seven, card, card], 3);
    expect(places[0]).toEqual({ column: 1, row: 1 });
    // Beside the single card of the last row, rather than underneath the whole block.
    expect(places[1]).toEqual({ column: 2, row: 3 });
    expect(places[2]).toEqual({ column: 3, row: 3 });
  });

  it('and the list is shorter for it', () => {
    expect(rowsUsed([seven, card, card], 3)).toBe(3);
  });

  it('and a full block still reserves everything it covers', () => {
    const solid: Tile = { columns: 3, rows: 3 };
    expect(rowsUsed([solid, card, card], 3)).toBe(4);
  });
});
