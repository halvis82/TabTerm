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
 * Order is kept wherever keeping it costs nothing: the fewest rows first, and among the ways to
 * reach them, the one that reads most nearly in age order. See `packTiles`.
 */
export interface Tile {
  /** How many columns this tile needs. Clamped to the grid's width by the caller. */
  columns: number;
  /** How many rows of cards tall it is: one for a card, one per wrapped row for a group. */
  rows: number;
  /**
   * How many columns the **last** row of this tile actually uses, when it is not a full one.
   *
   * A tab of seven panes is three across and three down, and its last row holds one card. Treating
   * it as a solid nine cell block reserved two cells that hold nothing, so other terminals were
   * pushed below a hole. Said here so the packing can offer those cells to somebody else and the
   * colour behind the tab can be cut to the shape it really occupies.
   */
  lastRow?: number;
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

  /*
   * The fewest rows first, and then the order they came in, kept as far as that allows.
   *
   * Tried from most to least chronological, and the first to reach the fewest rows any of them
   * reaches wins:
   *
   * 1. In order, left to right and top to bottom, each tile after the one before it. Reading the
   *    list reads them in age order. This is nearly always as short as anything else
   * 2. In order, but a later tile may go into a hole an earlier one left, when that saves a row
   * 3. The skyline below with a few orderings, biggest first, for the shapes the first two cannot
   *    fit as tightly, such as a tall tab whose side has to be filled before what comes after it
   *
   * Only the skyline was used before, and it always filled the lowest gap with the first tile that
   * fitted, whether or not that saved a row. So tiles jumped ahead of older ones for nothing, and a
   * tab landed under another while the row beside it stood empty: "weird patterns", reported with
   * a picture of a zoomed out list.
   */
  const inOrder: Placement[][] = [
    placeReading(tiles, columns, true),
    placeReading(tiles, columns, false),
  ];
  const reordered: Placement[][] = [
    tiles.map((_, at) => at),
    byMost(tiles, (tile) => tile.columns),
    byMost(tiles, (tile) => tile.columns * tile.rows),
    byMost(tiles, (tile) => tile.rows),
  ].map((order) => placeInOrder(tiles, order, columns));
  const fewest = Math.min(...[...inOrder, ...reordered].map((p) => heightOf(tiles, p)));

  /*
   * The ones that keep the order whenever they are as short as anything, and the reordered ones
   * only when they save a row. Between two of equal height: first the one with fewer holes in the
   * middle of a row, which are what make a list look scattered; then the one whose empty places
   * are lowest down, since empty places at the top of the list read as wrong as a tile out of
   * order; and only then the most nearly in order, which is the order they were made in.
   */
  const short = (set: Placement[][]): Placement[][] =>
    set.filter((p) => heightOf(tiles, p) === fewest);
  const pool = short(inOrder).length > 0 ? short(inOrder) : short(reordered);
  let best: Placement[] | null = null;
  let bestKey: number[] = [];
  for (const placed of pool) {
    const grid = occupancy(tiles, placed, columns, fewest);
    const key = [holesWithin(grid), ...gapsByRow(grid)];
    if (best === null || before(key, bestKey)) {
      bestKey = key;
      best = placed;
    }
  }
  return best ?? tiles.map(() => ({ column: 1, row: 1 }));
}

/** Which places are taken, row by row. */
function occupancy(
  tiles: readonly Tile[],
  places: readonly Placement[],
  columns: number,
  rows: number,
): boolean[][] {
  const grid = Array.from({ length: rows }, () => new Array<boolean>(columns).fill(false));
  places.forEach((place, at) => {
    const tile = tiles[at];
    if (!tile) return;
    const width = Math.max(1, Math.min(tile.columns, columns));
    const tall = Math.max(1, tile.rows);
    const last = Math.max(1, Math.min(tile.lastRow ?? width, width));
    for (let dr = 0; dr < tall; dr += 1) {
      const row = grid[place.row - 1 + dr];
      if (!row) continue;
      const across = dr === tall - 1 ? last : width;
      for (let dc = 0; dc < across; dc += 1) row[place.column - 1 + dc] = true;
    }
  });
  return grid;
}

/** Empty places with something to their right in the same row. */
function holesWithin(grid: readonly boolean[][]): number {
  let holes = 0;
  for (const row of grid) {
    const end = row.lastIndexOf(true);
    for (let c = 0; c < end; c += 1) if (!row[c]) holes += 1;
  }
  return holes;
}

/** Whether `a` comes first, comparing from the front. */
function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** How many places each row leaves empty, from the top, the last row not counted. */
function gapsByRow(grid: readonly boolean[][]): number[] {
  return grid.slice(0, -1).map((row) => row.filter((taken) => !taken).length);
}

/**
 * Each tile at the first place in reading order it fits, in the order given. `afterPrevious`
 * keeps every tile after the one before it, so the order reads exactly as given; without it a
 * tile may go into a hole earlier in the list.
 */
function placeReading(
  tiles: readonly Tile[],
  columns: number,
  afterPrevious: boolean,
): Placement[] {
  const taken: boolean[][] = [];
  const free = (r: number, c: number): boolean => !(taken[r]?.[c] ?? false);
  const cells = (tile: Tile, r: number, c: number): [number, number][] => {
    const width = Math.max(1, Math.min(tile.columns, columns));
    const tall = Math.max(1, tile.rows);
    const last = Math.max(1, Math.min(tile.lastRow ?? width, width));
    const out: [number, number][] = [];
    for (let dr = 0; dr < tall; dr += 1) {
      const across = dr === tall - 1 ? last : width;
      for (let dc = 0; dc < across; dc += 1) out.push([r + dr, c + dc]);
    }
    return out;
  };
  let after = -1;
  return tiles.map((tile) => {
    const width = Math.max(1, Math.min(tile.columns, columns));
    for (let at = afterPrevious ? after + 1 : 0; ; at += 1) {
      const r = Math.floor(at / columns);
      const c = at % columns;
      if (c + width > columns) continue;
      const mine = cells(tile, r, c);
      if (!mine.every(([cr, cc]) => free(cr, cc))) continue;
      for (const [cr, cc] of mine) (taken[cr] ??= [])[cc] = true;
      after = at;
      return { column: c + 1, row: r + 1 };
    }
  });
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
    const tall = Math.max(1, tile.rows);
    const last = Math.max(1, Math.min(tile.lastRow ?? width, width));
    out[index] = { column: start + 1, row: row + 1 };
    for (let at = start; at < start + width; at += 1) {
      // The columns its last row does not reach are free one row earlier, which is the hole the
      // next tile is offered.
      filled[at] = row + (at < start + last ? tall : tall - 1);
    }
  }

  return out.map((place) => place ?? { column: 1, row: 1 });
}

/** How many rows the packed list comes out at, which is the thing being minimised. */
export function rowsUsed(tiles: readonly Tile[], columns: number): number {
  return heightOf(tiles, packTiles(tiles, columns));
}
