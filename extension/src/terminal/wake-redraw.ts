/**
 * Whether a tab that has just been looked at again should ask what is running in it to repaint.
 *
 * A full-screen program writes only the cells it believes changed. Once its picture and the
 * terminal's have parted company, nothing brings them back on its own: the size is already
 * correct, so no size change is sent, so nothing repaints. A tab opened after five hours showed
 * an agent drawn across a third of the window with the rest blank, and reloading the page was the
 * only way out.
 *
 * A size change is the one thing every terminal application treats as "you know nothing, draw it
 * all", which is why the repair is a size nudged by a row and put back. The question this answers
 * is when that is worth doing, and it is a real question in both directions: never doing it
 * leaves the stale picture, and doing it on every glance repaints an agent several times a
 * minute, which is worse than the fault.
 *
 * Kept here rather than inline so the rule can be checked without waiting an hour for a tab to
 * go stale.
 */

/** Long enough that switching between two tabs never repaints anything. */
export const REDRAW_AFTER_AWAY_MS = 60_000;

/**
 * `hiddenSince` is when the tab was last hidden, or 0 for a tab that has not been away.
 *
 * A tab that was never hidden is never nudged. Regaining focus, coming back from the page cache
 * and being switched to all reach the same place, and only one of them means time has passed
 * without anybody being told what changed.
 */
export function shouldRedrawAfterAway(hiddenSince: number, now: number): boolean {
  if (hiddenSince <= 0) return false;
  const away = now - hiddenSince;
  // A clock that went backwards, which happens across a sleep. Not a reason to repaint.
  if (away < 0) return false;
  return away >= REDRAW_AFTER_AWAY_MS;
}
