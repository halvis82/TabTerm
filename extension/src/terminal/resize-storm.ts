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
 *
 * Two windows, because a loop does not have one speed. A fast one catches the several-a-second
 * flicker that was reported. A slow one catches an oscillation of one or two a second, which is
 * just as visible to the person watching and would sit under any threshold a two second window
 * can carry without firing on ordinary work.
 */

export interface SizeChange {
  at: number;
  cols: number;
  rows: number;
}

/** The fast window. Long enough to hold a flicker, short enough to be recent. */
export const RESIZE_WINDOW_MS = 2000;

/** Many changes among few sizes. Set below the five a second that was reported. */
const OSCILLATION_CHANGES = 6;
const OSCILLATION_DISTINCT = 4;

/** And a flood is a flood however varied it is: no legitimate drag reaches this rate. */
const FLOOD_CHANGES = 40;

/**
 * The slow window, for an oscillation of about one a second.
 *
 * Tighter on how many sizes it will accept, because over ten seconds a person doing real work
 * opens a panel, splits a pane and changes a font, and those are several sizes rather than two.
 * Two or three sizes going round for ten seconds is not work, it is a loop.
 */
export const SLOW_WINDOW_MS = 10_000;
const SLOW_CHANGES = 10;
const SLOW_DISTINCT = 3;

/** How long a run is worth keeping. The slow window is the longer of the two. */
export const HISTORY_MS = SLOW_WINDOW_MS;

/**
 * Add a change to the recent run, dropping what has aged out and what did not change anything.
 *
 * Several paths ask for a size without knowing whether anything moved: a terminal announcing
 * itself, a refit after a panel opens, an attach. Recording those inflated the count with events
 * that changed nothing, and it showed in real use: an ordinary reattach reported a storm made of
 * one deliberate nudge and three repeats of the size the pane already had. A count that includes
 * non-events measures activity rather than instability.
 */
export function recordChange<T extends SizeChange>(seen: readonly T[], change: T): T[] {
  const live = seen.filter((s) => change.at - s.at < HISTORY_MS);
  const last = live[live.length - 1];
  if (last && last.cols === change.cols && last.rows === change.rows) return live;
  return [...live, change];
}

/** How many different sizes appear in a run. */
export function distinctSizes(changes: readonly SizeChange[]): number {
  return new Set(changes.map((c) => `${String(c.cols)}x${String(c.rows)}`)).size;
}

const within = (changes: readonly SizeChange[], now: number, ms: number): SizeChange[] =>
  changes.filter((c) => now - c.at < ms);

/**
 * `changes` is what happened recently, oldest first, and `now` is when the question is asked.
 *
 * Deliberately not "is anything wrong", which nothing here can know. It is "is this worth writing
 * down", and the cost of a false positive is one line in a log every minute at most.
 */
export function isResizeStorm(changes: readonly SizeChange[], now?: number): boolean {
  const at = now ?? changes[changes.length - 1]?.at ?? 0;
  const fast = within(changes, at, RESIZE_WINDOW_MS);
  if (fast.length >= FLOOD_CHANGES) return true;
  if (fast.length >= OSCILLATION_CHANGES && distinctSizes(fast) <= OSCILLATION_DISTINCT)
    return true;
  const slow = within(changes, at, SLOW_WINDOW_MS);
  return slow.length >= SLOW_CHANGES && distinctSizes(slow) <= SLOW_DISTINCT;
}
