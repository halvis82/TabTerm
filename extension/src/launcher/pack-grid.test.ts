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

/**
 * Chronological as far as the fewest rows allows, from two photographs of the start screen.
 *
 * "it's supposed to be chronological to the extent it can be while also absolutely minimizing the
 * number of rows ... if i zoom out and get stuff like this, it's very weird". Newest first: a card,
 * a two pane tab, a five pane tab (three across, two down), two cards, a two pane tab, a card, and
 * a three pane tab.
 */
describe('the order of what is running', () => {
  const five: Tile = { columns: 3, rows: 2, lastRow: 2 };
  const three: Tile = { columns: 3, rows: 1 };
  const running: Tile[] = [card, pair, five, card, card, pair, card, three];
  const reading = (places: readonly { row: number; column: number }[]): number[] =>
    places.map((p) => (p.row - 1) * 100 + p.column);

  it('zoomed out, nine across: two rows, read exactly in order', () => {
    const places = packTiles(running, 9);
    expect(rowsUsed(running, 9)).toBe(2);
    const order = reading(places);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('five across: as few rows as any layout, the top rows full, and no hole inside a row', () => {
    const places = packTiles(running, 5);
    expect(rowsUsed(running, 5)).toBe(4);
    const used = new Map<number, number>();
    places.forEach((p, at) => {
      const tile = running[at] as Tile;
      for (let r = 0; r < tile.rows; r += 1) {
        const across = r === tile.rows - 1 ? (tile.lastRow ?? tile.columns) : tile.columns;
        used.set(p.row + r, (used.get(p.row + r) ?? 0) + across);
      }
    });
    expect([1, 2].map((r) => used.get(r))).toEqual([5, 5]);
    // Each row filled from the left, any empty places at its end.
    for (let row = 1; row <= 4; row += 1) {
      const taken = new Array<boolean>(5).fill(false);
      places.forEach((p, at) => {
        const tile = running[at] as Tile;
        if (row < p.row || row >= p.row + tile.rows) return;
        const across =
          row === p.row + tile.rows - 1 ? (tile.lastRow ?? tile.columns) : tile.columns;
        for (let c = 0; c < across; c += 1) taken[p.column - 1 + c] = true;
      });
      const end = taken.lastIndexOf(true);
      expect(taken.slice(0, end + 1).every(Boolean), `row ${String(row)}`).toBe(true);
    }
  });

  it('and a tile is only ever moved ahead to save a row or fill a gap above', () => {
    // Four cards in four columns: nothing to gain, so nothing moves.
    expect(reading(packTiles([card, card, pair, card, card], 4))).toEqual([1, 2, 3, 101, 102]);
  });
});
