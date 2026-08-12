/**
 * Hotstring expansion.
 *
 * An abbreviation followed by a space or Enter becomes a full command. See
 * docs/14-command-menu.md §4.
 *
 * Kept pure: it is handed keystrokes and returns what to do about them. That matters because the
 * decision is the risky part -- deleting characters the user typed and sending something else --
 * and it should be testable without a terminal, a PTY, or a browser.
 */

export interface Hotstring {
  /** The abbreviation, exactly as typed. */
  trigger: string;
  /** What it becomes. */
  command: string;
}

export interface ExpansionRequest {
  /** How many characters to remove from the line. */
  deleteCount: number;
  /** What to send in their place, including the delimiter. */
  insert: string;
  /** Which hotstring fired, for the caller to report. */
  trigger: string;
}

const SPACE = ' ';
const CARRIAGE_RETURN = '\r';
const NEWLINE = '\n';
const BACKSPACE = '\u007f';
const BACKSPACE_ALT = '\b';

/** Control characters other than the ones handled explicitly above. */
// eslint-disable-next-line no-control-regex
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

/**
 * Tracks what has been typed in one pane.
 *
 * Only keystrokes are tracked, never the screen. Output arrives at the same time and mixing the
 * two would make expansion depend on what a program happened to print. The cost is that a
 * command recalled from shell history never expands, because those characters were never typed
 * here; that is a real boundary and is documented rather than worked around.
 */
export class TypedBuffer {
  #typed = '';
  #suspended = false;

  /** Full-screen programs suspend expansion entirely. See docs/14-command-menu.md §4. */
  setSuspended(suspended: boolean): void {
    this.#suspended = suspended;
    if (suspended) this.#typed = '';
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get typed(): string {
    return this.#typed;
  }

  reset(): void {
    this.#typed = '';
  }

  /**
   * Feed one chunk of input and decide whether it completes a hotstring.
   *
   * Returns a request when the caller should rewrite the line, and null otherwise. The caller
   * does the rewriting, because only it can talk to the terminal.
   */
  consume(data: string, hotstrings: readonly Hotstring[]): ExpansionRequest | null {
    if (this.#suspended) return null;

    // Multi-character input is a paste or a key sequence, not typing. Expanding it would mean
    // rewriting text the user never entered a character at a time.
    if (data.length !== 1) {
      this.#typed = '';
      return null;
    }

    const ch = data;

    if (ch === SPACE || ch === CARRIAGE_RETURN || ch === NEWLINE) {
      const match = longestMatch(this.#typed, hotstrings);
      this.#typed = '';
      if (!match) return null;
      return {
        deleteCount: match.trigger.length,
        // The delimiter is reproduced, so a space stays a space and Enter still submits.
        insert: match.command + (ch === SPACE ? SPACE : ch),
        trigger: match.trigger,
      };
    }

    if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
      this.#typed = this.#typed.slice(0, -1);
      return null;
    }

    // Any other control character means something happened this cannot model: an arrow key, a
    // completion, an interrupt. Give up rather than expand against a line that may no longer
    // look the way this thinks it does.
    if (OTHER_CONTROL.test(ch)) {
      this.#typed = '';
      return null;
    }

    this.#typed += ch;
    // Bounded: a line nobody is going to match against does not need remembering.
    if (this.#typed.length > 512) this.#typed = this.#typed.slice(-512);
    return null;
  }
}

/**
 * The longest hotstring the typed text ends with.
 *
 * Longest wins so a more specific abbreviation beats a shorter one that happens to be its
 * suffix, which is the only sensible reading when both match.
 */
function longestMatch(typed: string, hotstrings: readonly Hotstring[]): Hotstring | null {
  let best: Hotstring | null = null;
  for (const hotstring of hotstrings) {
    if (!hotstring.trigger) continue;
    if (!typed.endsWith(hotstring.trigger)) continue;
    if (!best || hotstring.trigger.length > best.trigger.length) best = hotstring;
  }
  return best;
}

/** The keystrokes that delete an abbreviation from the line. */
export function backspaces(count: number): string {
  return BACKSPACE.repeat(count);
}
