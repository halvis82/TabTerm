/**
 * Which keystrokes belong to the terminal, and which belong to the page.
 *
 * The distinction people actually care about on macOS: **Control keys reach the shell,
 * Command keys do not.** `Ctrl+C` must interrupt, and `Cmd+C` must copy without interrupting
 * anything. Getting that backwards, in either direction, is the difference between a terminal
 * and a text box that looks like one.
 *
 * Kept pure so it can be tested without a renderer or a browser.
 * See docs/07-terminal-fidelity.md.
 */

export type KeyAction =
  | { kind: 'to-pty' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'select-all' }
  | { kind: 'clear' }
  | { kind: 'search' }
  /**
   * A newline inside what is being typed, rather than the end of it.
   *
   * A program taking more than one line reads `ESC CR` as "another line" and a bare `CR` as "I
   * have finished". Option and Return already produces the first, because Option is Meta here.
   * Command and Return produced nothing at all: it fell through to the arm that hands a key back
   * to Chrome, which has no use for it either.
   */
  | { kind: 'newline' }
  | { kind: 'browser' };

export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  type: string;
  /** Whether anything is selected right now, which changes what Command+C should mean. */
  hasSelection: boolean;
}

/**
 * Decide what a keystroke means.
 *
 * `to-pty` is the default on purpose. Anything not deliberately claimed here belongs to the
 * shell, because a terminal that silently swallows keys is worse than one that passes through
 * something the page might have wanted.
 */
export function classifyKey(e: KeyInput): KeyAction {
  if (e.type !== 'keydown') return { kind: 'to-pty' };

  // Control is the shell's. Every Ctrl+letter goes straight through, including Ctrl+C, which
  // must interrupt rather than copy.
  if (e.ctrlKey && !e.metaKey) return { kind: 'to-pty' };

  if (e.metaKey) {
    const key = e.key.toLowerCase();
    switch (key) {
      case 'enter':
        /*
         * The same thing Option and Return does, on the key people reach for.
         *
         * Both are worth having. Option is what a terminal has always used and what a program
         * expects to be told; Command is what somebody moving from a chat window presses. The
         * program cannot tell them apart, which is the point.
         */
        return { kind: 'newline' };
      case 'c':
        // With nothing selected there is nothing to copy, so let Chrome have it rather than
        // eating the keystroke. It never reaches the shell either way.
        return e.hasSelection ? { kind: 'copy' } : { kind: 'browser' };
      case 'v':
        return { kind: 'paste' };
      case 'a':
        return { kind: 'select-all' };
      case 'k':
        /**
         * Neither of these is decided here any more.
         *
         * The command panel and clearing are both page shortcuts, chosen in settings, and this
         * table used to answer for one of them as well. Both fired: clearing ran twice, and the
         * second run saved the already cleared screen as what to put back, so taking a clear
         * back restored a bare prompt. Two owners for one key is a defect whatever the key does.
         *
         * The page still gets the keystroke, because `browser` here means "not ours to swallow",
         * and its own table is what acts on it.
         */
        return { kind: 'browser' };
      case 'f':
        return { kind: 'search' };
      default:
        // Command+W, Command+T, Command+number and the rest are Chrome's, and in a normal tab
        // they never reach the page at all. See docs/10-limitations.md tier 0.4.
        return { kind: 'browser' };
    }
  }

  return { kind: 'to-pty' };
}

/**
 * Should xterm handle this key itself?
 *
 * xterm's custom handler uses this convention: returning false means "I have dealt with it",
 * and true means "carry on and send it to the PTY".
 */
export function xtermShouldHandle(action: KeyAction): boolean {
  return action.kind === 'to-pty';
}
