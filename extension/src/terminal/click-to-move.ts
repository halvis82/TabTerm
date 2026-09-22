/**
 * Clicking where you want the cursor, in a program that never asked for the mouse.
 *
 * Asked for by name: "in claude in iterm, you can click places. you can click somewhere in the
 * text input box for example and the cursor goes where you click". A terminal cannot move another
 * program's cursor, and the obvious mechanism is not available here: **Claude does not turn mouse
 * reporting on at all**. Measured rather than assumed, by reading what it sets on a fresh start:
 * `?1004h`, `?2004h`, `?2026`, `?2031` and `?25`. No `?1000`, `?1002`, `?1003` or `?1006`.
 *
 * So the click is emulated the way iTerm emulates it: arrow keys, one per column, which is what a
 * person would press to get there. Nothing is invented about the program's state; the keys are the
 * ones a person has, and a program that ignores arrows ignores these too.
 *
 * It is deliberately narrow, because arrow keys mean other things elsewhere:
 *
 * - **Only when the program has not asked for the mouse.** One that has gets the real report, and
 *   this stays out of its way entirely
 * - **Only on the row the cursor is on.** That is what a line being edited looks like from
 *   outside, and a click anywhere else is somebody pointing at old output
 * - **Only on the normal screen.** A full-screen program owns the alternate screen, and there an
 *   arrow key is navigation rather than a caret
 * - **Only a click that selected nothing**, so dragging out a selection is untouched
 */

export interface ClickToMove {
  /** Where the click landed, in cells, counted from zero. */
  column: number;
  row: number;
  /** Where the cursor is, in the same coordinates. */
  cursorColumn: number;
  cursorRow: number;
  /** What the program has asked for, and where it is drawing. */
  mouseIsTaken: boolean;
  onAlternateScreen: boolean;
  /** Whether the click left a selection behind, which means it was a drag. */
  selected: boolean;
  /** `?1` changes what an arrow key looks like on the wire. */
  applicationCursorKeys: boolean;
}

/** How far a single click may move the cursor, so a stray click cannot send a hundred keys. */
const MOST_COLUMNS = 400;

/**
 * The keys to send, or an empty string when this click is not one of these.
 *
 * Empty is the common answer and the safe one: the click then does exactly what it did before.
 */
export function keysForClick(at: ClickToMove): string {
  if (at.mouseIsTaken || at.onAlternateScreen || at.selected) return '';
  if (at.row !== at.cursorRow) return '';

  const distance = at.column - at.cursorColumn;
  if (distance === 0 || Math.abs(distance) > MOST_COLUMNS) return '';

  const key = at.applicationCursorKeys ? (distance > 0 ? 'OC' : 'OD') : distance > 0 ? '[C' : '[D';
  return key.repeat(Math.abs(distance));
}
