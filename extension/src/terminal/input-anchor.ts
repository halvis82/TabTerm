/**
 * Where the line somebody typed ended up on the screen.
 *
 * A mark is made when Return is pressed, at the line the cursor is on. In a shell that is the
 * command line and there is nothing more to do. In a pane running an agent the cursor at that
 * moment is inside an input box at the bottom of the screen, and a moment later the agent has
 * redrawn: the box is empty again and what was typed has been printed somewhere above it, as part
 * of the transcript. The mark is then several rows below the prompt it is a mark for, which is
 * what "the prompt indicators in the scroll bar still don't line up with the actual prompts" was.
 *
 * So the mark is moved to wherever the text turned up. This looks for **a string we ourselves
 * sent**, which is not the same thing as reading a program's output to work out what it is doing:
 * nothing here decides that an agent is busy, or idle, or has finished. ADR-0009 forbids that and
 * this does not do it. When the text is not found the mark stays where the cursor was, which is
 * the behavior this replaces.
 */

/**
 * Below this many characters a line is not worth looking for.
 *
 * `y`, `2`, `ok` and `no` are typed constantly, and every one of them appears all over the output
 * of the program they were typed at. A mark that moved to the wrong copy would be worse than one
 * left at the cursor, because it would point confidently at somebody else's line.
 */
const ENOUGH = 6;

/** Long enough to be the only line that says it, short enough to fit on a wrapped row. */
const HEAD = 40;

/** A second, shorter try, for when the program wrapped the line before the fortieth column. */
const SHORT_HEAD = 16;

/** The rows to search, and which row the first of them is. */
export interface Where {
  from: number;
  lines: readonly string[];
}

/**
 * One run of whitespace is one space, everywhere.
 *
 * Applied to both sides of the comparison, so a program that reflowed the line, indented it, or
 * drew a box around it still matches what was typed. Nothing else is normalized: the text is
 * being recognized, not interpreted.
 */
function flat(text: string): string {
  return text
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What to look for, longest first, or nothing when the line is too ordinary to find again. */
export function needlesFor(typed: string): string[] {
  const line = flat(typed);
  if (line.length < ENOUGH) return [];
  const head = line.slice(0, HEAD).trimEnd();
  const short = line.slice(0, SHORT_HEAD).trimEnd();
  return short.length >= ENOUGH && short !== head ? [head, short] : [head];
}

/**
 * The row the typed line is on, or null when it is not there to be found.
 *
 * The nearest match to where the cursor was wins. A prompt typed twice is two rows saying the same
 * thing, and the one this mark belongs to is the one beside it; searching from the top of the
 * buffer would find the first time anybody ever typed it. A tie goes to the row above, because a
 * program prints what it was told above the box it was typed into.
 */
export function rowOfTyped(where: Where, typed: string, near: number): number | null {
  for (const needle of needlesFor(typed)) {
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < where.lines.length; i++) {
      const line = where.lines[i];
      if (line === undefined || !flat(line).includes(needle)) continue;
      const row = where.from + i;
      const distance = Math.abs(row - near);
      if (distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (best !== null) return best;
  }
  return null;
}

const BACKSPACE = '';
const BACKSPACE_ALT = '\b';
const ESCAPE = '';
/** What xterm wraps a paste in when the program has asked for bracketed paste. */
const PASTE_START = '[200~';
const PASTE_END = '[201~';

/**
 * The line as it is being typed, kept so there is something to look for once it is submitted.
 *
 * Counted from the keystrokes rather than read off the screen, for the same reason `input-line.ts`
 * counts its length that way: what is on the screen depends on the program, and the program this
 * matters most for draws its input box wherever it likes.
 *
 * It gives up rather than guess. Giving up means an empty line, and an empty line means the mark
 * stays where the cursor was.
 */
export class TypedLine {
  #text = '';

  /** Feed one chunk being sent to the program. Returns the line, when this chunk submitted one. */
  consume(data: string): string | null {
    if (data === '') return null;

    /*
     * A paste, wrapped the way the program asked for it.
     *
     * Unwrapped rather than given up on, because pasting a long instruction into an agent is one
     * of the commonest ways this line gets typed at all, and the markers are least use without it.
     * A line break inside a paste is not a submit: the program has been handed the text and put
     * all of it in its box.
     */
    if (data.startsWith(PASTE_START)) {
      const end = data.endsWith(PASTE_END) ? data.length - PASTE_END.length : data.length;
      this.#text += data.slice(PASTE_START.length, end).replace(/[\r\n]+/g, ' ');
      return null;
    }

    if (data.startsWith(ESCAPE)) {
      /*
       * Shift and Return sends `ESC CR`: a new line inside the program's own box, not a submit.
       * The line goes on, and the break becomes a space so the start of it still reads as typed.
       */
      if (/[\r\n]/.test(data)) {
        this.#text += ' ';
        return null;
      }
      // Any other key sequence. It means something this cannot model, so the line is given up.
      this.#text = '';
      return null;
    }

    // A submit ends the line, and anything before it in the same chunk is on that line.
    const at = data.search(/[\r\n]/);
    if (at >= 0) {
      const line = this.#text + data.slice(0, at);
      this.#text = '';
      return line;
    }

    if (data.length === 1) {
      if (data === BACKSPACE || data === BACKSPACE_ALT) {
        this.#text = this.#text.slice(0, -1);
        return null;
      }
      // An arrow key, an interrupt, a kill, a completion: every one of them edits the line in a
      // way this does not model, so it stops claiming to know what is on it.
      if (data < ' ') this.#text = '';
      else this.#text += data;
      return null;
    }

    // A paste the program never asked to have brackets on. It is on the line like anything else.
    this.#text += data;
    return null;
  }
}
