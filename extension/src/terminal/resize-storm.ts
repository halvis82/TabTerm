/**
 * Whether a run of size changes is a terminal resizing itself in a loop.
 *
 * A terminal caught in one is visible to the person watching it and to nothing else: by the time
 * it is described the evidence is gone, and asking somebody to open a console while it is
 * happening is asking them to do the debugging.
 *
 * The hard part is telling a loop from somebody dragging the window edge, which produces just as
 * many changes and is not a fault. Counting alone cannot do it, and the first version of this
 * tried: it reported at twelve changes in two seconds, which is six a second, while the flicker
 * that was actually reported was about five. The guard was set above the fault it was guarding
 * against.
 *
 * What separates them is not how many changes there are but how many **different sizes**. A drag
 * moves through a new size every time and never comes back to one. A loop is two or three sizes
 * repeating, because something is feeding its own input. So a few sizes changed many times is a
 * loop, and many sizes changed many times is a person with a mouse.
 */

export interface SizeChange {
  at: number;
  cols: number;
  rows: number;
}

/** The span the changes are counted over. Long enough to hold a loop, short enough to be recent. */
export const RESIZE_WINDOW_MS = 2000;

/** Many changes among few sizes. Set below the five a second that was reported. */
const OSCILLATION_CHANGES = 6;
const OSCILLATION_DISTINCT = 4;

/** And a flood is a flood however varied it is: no legitimate drag reaches this rate. */
const FLOOD_CHANGES = 40;

/** How many different sizes appear in a run. */
export function distinctSizes(changes: readonly SizeChange[]): number {
  return new Set(changes.map((c) => `${String(c.cols)}x${String(c.rows)}`)).size;
}

/**
 * `changes` is what happened inside the window, oldest first.
 *
 * Deliberately not "is anything wrong", which nothing here can know. It is "is this worth
 * writing down", and the cost of a false positive is one line in a log every minute at most.
 */
export function isResizeStorm(changes: readonly SizeChange[]): boolean {
  if (changes.length >= FLOOD_CHANGES) return true;
  if (changes.length < OSCILLATION_CHANGES) return false;
  return distinctSizes(changes) <= OSCILLATION_DISTINCT;
}
