/**
 * Highlights as ranges on a line, and what happens when they touch.
 *
 * A highlight used to be an independent decoration, so highlighting "sen", then "ce sent", then
 * "nice senten" left three translucent layers piled on the overlap, each darker than the last.
 * The colors were stacking because the ranges were not.
 *
 * Treating a line's highlights as a set of ranges answers three of the reported behaviors with
 * one rule:
 *
 * - **Overlapping ranges merge**, so a wash is a wash however many times it was painted
 * - **Adding exactly what is already there removes it**, which is the natural way to toggle
 * - **Adding something wider keeps what was there and extends it**, which is just the merge
 *
 * Removing follows too: the run to remove is everything connected to the point, and connected is
 * what merging already decided.
 */

export interface Range {
  start: number;
  /** Exclusive, so an empty range is start === end and cannot be created by accident. */
  end: number;
}

const overlapsOrTouches = (a: Range, b: Range): boolean => a.start <= b.end && b.start <= a.end;

/** The same span, to the character. What toggling a highlight off looks for. */
export function sameRange(a: Range, b: Range): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Ranges in order, with everything that overlaps or touches joined into one. */
export function merge(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && overlapsOrTouches(last, range)) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    out.push({ start: range.start, end: range.end });
  }
  return out;
}

/**
 * Add a range to a line's highlights, or take it away when it is exactly one of them.
 *
 * The exact-match check runs against the ranges as they are, before merging, so highlighting
 * precisely what is highlighted removes it and highlighting anything else extends.
 */
export function addOrToggle(existing: readonly Range[], range: Range): Range[] {
  if (existing.some((r) => sameRange(r, range))) {
    return existing.filter((r) => !sameRange(r, range)).map((r) => ({ ...r }));
  }
  return merge([...existing, range]);
}

/** The range covering a column, if one does. */
export function rangeAt(ranges: readonly Range[], column: number): Range | null {
  return ranges.find((r) => column >= r.start && column < r.end) ?? null;
}

/**
 * Everything connected to a point, across lines as well as along one.
 *
 * "Continuous with that" means what it looks like: a block of color that reaches the point, not
 * whatever happened to be highlighted in the same gesture. Two rows are connected when their
 * ranges overlap in columns, which is what makes a multi-line highlight read as one block and
 * therefore what makes it come off as one.
 */
export function connected(
  lines: ReadonlyMap<number, readonly Range[]>,
  row: number,
  column: number,
): { row: number; range: Range }[] {
  const start = rangeAt(lines.get(row) ?? [], column);
  if (!start) return [];

  const found = new Map<string, { row: number; range: Range }>();
  const queue: { row: number; range: Range }[] = [{ row, range: start }];

  while (queue.length > 0) {
    const here = queue.shift();
    if (!here) break;
    const key = `${String(here.row)}:${String(here.range.start)}`;
    if (found.has(key)) continue;
    found.set(key, here);

    for (const neighbor of [here.row - 1, here.row + 1]) {
      for (const range of lines.get(neighbor) ?? []) {
        // Overlapping columns, not merely touching: two ranges that only meet at an edge are
        // side by side on different rows rather than part of the same block.
        if (range.start < here.range.end && here.range.start < range.end) {
          queue.push({ row: neighbor, range });
        }
      }
    }
  }
  return [...found.values()];
}
