/**
 * How long the line being typed is, counted from the keystrokes rather than read off the screen.
 *
 * The screen cannot answer this in the one place it matters. The start screen leaves the terminal
 * a few rows tall, and in a terminal that short zsh does not wrap a long line: it truncates the
 * display and draws `>....` to say so. There are no wrapped rows to count and the line is
 * genuinely not on the screen. Two earlier attempts read the screen and both were wrong here.
 *
 * Deliberately not the buffer that watches for abbreviations, which looks similar and answers a
 * different question: it forgets the line on every space, because a space ends a trigger, and it
 * keeps only the last 512 characters, because nothing longer can match. Reusing it made the box
 * stop growing at about six rows and reset every time somebody typed a word.
 *
 * This is an estimate and says so. It gives up rather than guess whenever something happens it
 * cannot model, and giving up means "the line is short", which is the harmless direction: the box
 * stays small rather than growing to fill the window over a line that is not there.
 */

const RETURN = '\r';
const NEWLINE = '\n';
const BACKSPACE = '';
const BACKSPACE_ALT = '\b';
const ESCAPE = '';

export class InputLine {
  #length = 0;

  get length(): number {
    return this.#length;
  }

  reset(): void {
    this.#length = 0;
  }

  /**
   * Feed one chunk of what is being sent to the shell.
   *
   * A chunk of more than one character is a paste or a key sequence. A paste counts, because it
   * is text on the line like any other; a key sequence begins with escape and means something
   * this cannot model, so the count is given up.
   */
  consume(data: string): void {
    if (data === '') return;

    // Anything containing a submit ends the line, whatever else is in it.
    if (data.includes(RETURN) || data.includes(NEWLINE)) {
      this.#length = 0;
      return;
    }

    if (data.length === 1) {
      if (data === BACKSPACE || data === BACKSPACE_ALT) {
        this.#length = Math.max(0, this.#length - 1);
        return;
      }
      /**
       * A control character is an arrow key, an interrupt, a kill, a completion.
       *
       * Every one of them can change the line in a way this does not model, so the count goes
       * back to nothing rather than drifting. Control U and Control C really do empty the line,
       * and for the others being wrong small is the right direction to be wrong in.
       */
      if (data < ' ') {
        this.#length = 0;
        return;
      }
      this.#length += 1;
      return;
    }

    // A key sequence rather than text. Escape leads all of them.
    if (data.startsWith(ESCAPE)) {
      this.#length = 0;
      return;
    }

    // A paste. It is on the line, so it counts.
    this.#length += data.length;
  }
}

/**
 * How many rows a line of this length needs, including the prompt in front of it.
 *
 * The trailing character is the cursor, which needs somewhere to sit: a line that exactly fills
 * the width puts the cursor on the next row, and a box that did not allow for it hid the cursor.
 */
export function rowsNeeded(promptColumns: number, length: number, cols: number): number {
  const width = Math.max(1, cols);
  return Math.max(1, Math.ceil((Math.max(0, promptColumns) + length + 1) / width));
}
