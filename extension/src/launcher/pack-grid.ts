/**
 * Placing the tiles of `Running now` so the list is as short as it can be.
 *
 * The grid used to place them itself, in order, with `dense` packing to backfill gaps. That gets
 * most cases right and cannot get this one right: a tab with seven panes is three columns wide and
 * three rows tall, which leaves a column beside it three rows deep, and the only thing the browser
 * will move into a gap is an item that comes **after** it. The cards that fit were older, so they
 * had already been placed above, and the list ran a whole row longer than it needed to.
 *
 * Asked for as tetris, which is exactly what it is: rectangles of known size into a strip of known
 * width, shortest total height.
 *
 * Order is kept wherever keeping it costs nothing. The scan below always takes the **first**
 * remaining tile that fits the gap in front of it, so tiles stay in age order except where a later
 * one is pulled forward to fill a hole that would otherwise stay empty. That is the trade he asked
 * for: chronological, unless something can be done simply to save a row.
 */
export interface Tile {
  /** How many columns this tile needs. Clamped to the grid's width by the caller. */
  columns: number;
  /** How many rows of cards tall it is: one for a card, one per wrapped row for a group. */
  rows: number;
}

export interface Placement {
  /** One-based, ready for `grid-column-start`. */
  column: number;
  /** One-based, ready for `grid-row-start`. */
  row: number;
}

/**
 * Where each tile goes, in the order they were given.
 *
 * A skyline: how far down each column has been filled. The gap in front is the lowest run of
 * columns, and the first tile that fits it goes there. When nothing fits, that run is raised to
 * meet its lowest neighbour, which merges it into a wider gap rather than leaving it stranded.
 */
export function packTiles(tiles: readonly Tile[], columns: number): Placement[] {
  if (columns < 1) return tiles.map(() => ({ column: 1, row: 1 }));

  /**
   * A few orderings tried, and the shortest kept.
   *
   * Filling gaps as they come keeps the order but cannot reach the best answer on its own: the
   * photographed case needs the seven pane tab considered before the cards that go beside it, and
   * no amount of looking forward from an earlier tile finds that. There are never more than a
   * dozen tiles here, so trying the obvious orders and measuring costs nothing.
   *
   * The order given comes first and wins every tie, so nothing is reordered unless reordering
   * actually saves a row. That is the trade he asked for.
   */
  const orders: number[][] = [
    tiles.map((_, at) => at),
    byMost(tiles, (tile) => tile.columns),
    byMost(tiles, (tile) => tile.columns * tile.rows),
    byMost(tiles, (tile) => tile.rows),
  ];

  let best: Placement[] | null = null;
  let bestRows = Infinity;
  for (const order of orders) {
    const placed = placeInOrder(tiles, order, columns);
    const rows = heightOf(tiles, placed);
    if (rows < bestRows) {
      bestRows = rows;
      best = placed;
    }
  }
  return best ?? tiles.map(() => ({ column: 1, row: 1 }));
}

/** The indexes of the tiles, biggest first by some measure, ties in the order they arrived. */
function byMost(tiles: readonly Tile[], of: (tile: Tile) => number): number[] {
  return tiles
    .map((tile, at) => ({ at, size: of(tile) }))
    .sort((a, b) => b.size - a.size || a.at - b.at)
    .map((entry) => entry.at);
}

function heightOf(tiles: readonly Tile[], places: readonly Placement[]): number {
  let rows = 0;
  places.forEach((place, at) => {
    const tile = tiles[at];
    if (!tile) return;
    rows = Math.max(rows, place.row - 1 + Math.max(1, tile.rows));
  });
  return rows;
}

/** One pass of the skyline, taking tiles in the order given. */
function placeInOrder(
  tiles: readonly Tile[],
  order: readonly number[],
  columns: number,
): Placement[] {
  const filled = new Array<number>(columns).fill(0);
  const out: (Placement | undefined)[] = new Array<Placement | undefined>(tiles.length);
  const left = order.flatMap((index) => {
    const tile = tiles[index];
    return tile ? [{ tile, index }] : [];
  });

  while (left.length > 0) {
    const row = Math.min(...filled);
    const start = filled.indexOf(row);
    let run = 0;
    while (start + run < columns && filled[start + run] === row) run += 1;

    const next = left.findIndex(({ tile }) => Math.min(tile.columns, columns) <= run);
    if (next === -1) {
      /*
       * Nothing fits this gap, so it stops being a gap on its own.
       *
       * Raised to whatever its lowest neighbour is, which joins it to the run beside it. Without
       * this a one column hole in front of a two column tile would be chosen forever and the loop
       * would never end.
       */
      const neighbours = filled.filter((_, at) => at < start || at >= start + run);
      const floor = neighbours.length > 0 ? Math.min(...neighbours) : row + 1;
      const raised = Math.max(row + 1, floor);
      for (let at = start; at < start + run; at += 1) filled[at] = raised;
      continue;
    }

    const { tile, index } = left.splice(next, 1)[0] as { tile: Tile; index: number };
    const width = Math.max(1, Math.min(tile.columns, columns));
    out[index] = { column: start + 1, row: row + 1 };
    for (let at = start; at < start + width; at += 1) filled[at] = row + Math.max(1, tile.rows);
  }

  return out.map((place) => place ?? { column: 1, row: 1 });
}

/** How many rows the packed list comes out at, which is the thing being minimised. */
export function rowsUsed(tiles: readonly Tile[], columns: number): number {
  return heightOf(tiles, packTiles(tiles, columns));
}
